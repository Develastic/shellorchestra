// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package staticserver

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"shellorchestra/backend/internal/config"
	"shellorchestra/backend/internal/httplimits"
	"shellorchestra/backend/internal/httpsecurity"
	"shellorchestra/backend/internal/serviceinfo"
)

func Handler(publicDir string) http.Handler {
	files := http.FileServer(http.Dir(publicDir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httpsecurity.ApplyBrowserSecurityHeaders(w.Header())
		if err := httpsecurity.ValidateRequestPath(r); err != nil {
			http.Error(w, "Request path is not normalized.", http.StatusBadRequest)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
			files.ServeHTTP(w, r)
			return
		}
		if r.URL.Path == "/" || !strings.Contains(filepath.Base(r.URL.Path), ".") {
			w.Header().Set("Cache-Control", "no-store")
			serveIndexHTML(w, r, filepath.Join(publicDir, "index.html"))
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=3600")
		files.ServeHTTP(w, r)
	})
}

func serveIndexHTML(w http.ResponseWriter, r *http.Request, path string) {
	content, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "Application shell is not available.", http.StatusInternalServerError)
		return
	}
	nonce, err := httpsecurity.NewCSPNonce()
	if err != nil {
		http.Error(w, "Application shell security nonce could not be generated.", http.StatusInternalServerError)
		return
	}
	if r.URL.Path == "/editor-frame" {
		httpsecurity.ApplySandboxedEditorSecurityHeadersWithNonce(w.Header(), nonce)
	} else {
		httpsecurity.ApplyBrowserSecurityHeadersWithNonce(w.Header(), nonce)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(httpsecurity.HTMLWithCSPNonce(content, nonce)))
}

func ListenAndServe(ctx context.Context, cfg config.AppConfig) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/service/status", serviceinfo.Handler(cfg, "static-cdn", nil))
	mux.Handle("/", Handler(cfg.App.PublicDir))
	server := &http.Server{Addr: cfg.App.ListenAddr, Handler: mux, ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: httplimits.MaxHeaderBytes}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	log.Printf("ShellOrchestra static CDN listening on %s", cfg.App.ListenAddr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}
