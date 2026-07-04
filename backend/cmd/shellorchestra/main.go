// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package main

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"shellorchestra/backend/internal/apprunner"
	"shellorchestra/backend/internal/apprunnerclient"
	"shellorchestra/backend/internal/auditlog"
	"shellorchestra/backend/internal/casigner"
	"shellorchestra/backend/internal/config"
	"shellorchestra/backend/internal/feedback"
	"shellorchestra/backend/internal/fileversion"
	"shellorchestra/backend/internal/gateway"
	"shellorchestra/backend/internal/httpapi"
	"shellorchestra/backend/internal/httplimits"
	"shellorchestra/backend/internal/runtime"
	"shellorchestra/backend/internal/scripts"
	"shellorchestra/backend/internal/staticserver"
	"shellorchestra/backend/internal/store"
	"shellorchestra/backend/internal/updater"
	"shellorchestra/backend/internal/vulnscanner"
	"shellorchestra/backend/internal/worker"
)

const maxTerminalBridgeTokenBytes int64 = 4096

func main() {
	configPath := flag.String("config", "config.toml", "Path to config.toml")
	role := flag.String("role", "all", "Service role: all, static, gateway, app-runner, auth, api, worker, ca-signer, vulnerability-scanner, updater")
	terminalSocket := flag.String("terminal-socket", "", "Internal terminal bridge socket for terminal-proxy role")
	terminalTokenFile := flag.String("terminal-token-file", "", "Internal terminal bridge token file for terminal-proxy role")
	flag.Parse()

	if *role == "terminal-proxy" {
		if err := runTerminalProxy(*terminalSocket, *terminalTokenFile); err != nil {
			fmt.Fprintf(os.Stderr, "ShellOrchestra terminal proxy failed: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if *role == "terminal-output-proxy" {
		if err := runTerminalOutputProxy(*terminalSocket, *terminalTokenFile); err != nil {
			fmt.Fprintf(os.Stderr, "ShellOrchestra terminal output proxy failed: %v\n", err)
			os.Exit(1)
		}
		return
	}

	if runWindowsServiceIfNeeded(*role, func(ctx context.Context) {
		runShellOrchestra(ctx, *configPath, *role)
	}) {
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	runShellOrchestra(ctx, *configPath, *role)
}

func runShellOrchestra(ctx context.Context, configPath string, role string) {
	cfg, err := config.LoadForRole(configPath, role)
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	switch role {
	case "static":
		if err := staticserver.ListenAndServe(ctx, cfg); err != nil {
			log.Fatalf("static server failed: %v", err)
		}
		return
	case "gateway":
		if err := gateway.ListenAndServe(ctx, cfg); err != nil {
			log.Fatalf("gateway failed: %v", err)
		}
		return
	case "app-runner":
		if err := apprunner.ListenAndServe(ctx, cfg); err != nil {
			log.Fatalf("app-runner failed: %v", err)
		}
		return
	case "vulnerability-scanner":
		if err := vulnscanner.ListenAndServe(ctx, cfg); err != nil {
			log.Fatalf("vulnerability scanner failed: %v", err)
		}
		return
	case "updater":
		if err := updater.ListenAndServe(ctx, cfg); err != nil {
			log.Fatalf("updater failed: %v", err)
		}
		return
	}

	db, err := store.OpenSQLite(cfg.Database.Path)
	if err != nil {
		log.Fatalf("failed to open database: %v", err)
	}
	defer db.Close()

	if role == "ca-signer" {
		log.Printf("ShellOrchestra ca-signer service listening on %s", cfg.App.ListenAddr)
		if err := casigner.ListenAndServe(ctx, cfg, db); err != nil {
			log.Fatalf("ca-signer service failed: %v", err)
		}
		return
	}

	catalog, err := scripts.LoadCatalog(cfg.Scripts.Root, cfg.Scripts.DefaultTimeoutSeconds)
	if err != nil {
		log.Fatalf("failed to load script catalog: %v", err)
	}

	var signerClient *casigner.Client
	if role == "worker" || role == "api" || role == "auth" {
		if cfg.Internal.SignerURL == "" {
			log.Fatalf("internal.signer_url is required for %s role", role)
		}
		signerClient, err = casigner.NewClient(cfg.Internal.SignerURL, cfg.Internal.SharedSecret)
		if err != nil {
			log.Fatalf("failed to create CA signer client: %v", err)
		}
	}
	if role == "worker" {
		log.Printf("ShellOrchestra worker service listening on %s", cfg.App.ListenAddr)
		if err := worker.ListenAndServe(ctx, cfg, db, catalog, signerClient); err != nil {
			log.Fatalf("worker service failed: %v", err)
		}
		return
	}

	var versionStore *fileversion.Store
	var auditStore *auditlog.Store
	var feedbackStore *feedback.Store
	if role == "api" || role == "all" {
		versionStore, err = fileversion.Open(fileversion.Options{
			Path:    siblingDatabasePath(cfg.Database.Path, "versions.db"),
			KeyPath: siblingDatabasePath(cfg.Database.Path, "versions.key"),
		})
		if err != nil {
			log.Fatalf("failed to open file version database: %v", err)
		}
		defer versionStore.Close()

		auditStore, err = auditlog.Open(auditlog.Options{
			Path:    siblingDatabasePath(cfg.Database.Path, "audit.db"),
			KeyPath: siblingDatabasePath(cfg.Database.Path, "audit.signing.key"),
		})
		if err != nil {
			log.Fatalf("failed to open audit database: %v", err)
		}
		defer auditStore.Close()

		feedbackStore, err = feedback.Open(feedback.Options{
			Path: siblingDatabasePath(cfg.Database.Path, "feedback.db"),
		})
		if err != nil {
			log.Fatalf("failed to open debug feedback database: %v", err)
		}
		defer feedbackStore.Close()
	}

	sshRuntime := runtime.NewSSHRuntime(runtime.Options{
		ConnectTimeout: time.Duration(cfg.Runtime.ConnectTimeoutSeconds) * time.Second,
		StatusInterval: time.Duration(cfg.Runtime.LightStatusIntervalSeconds) * time.Second,
		CertTTL:        time.Duration(cfg.SSHCA.CertTTLMinutes) * time.Minute,
	})
	if settings, err := db.GetSSHSecuritySettings(ctx); err == nil {
		sshRuntime.SetAllowedSourceAddresses(settings.AllowedSourceAddresses)
		sshRuntime.SetCertificateTTL(time.Duration(settings.CertTTLMinutes) * time.Minute)
	} else {
		log.Fatalf("failed to load SSH security settings: %v", err)
	}

	var workerClient *worker.Client
	if role == "api" || role == "auth" {
		if cfg.Internal.WorkerURL == "" {
			log.Fatalf("internal.worker_url is required for %s role", role)
		}
		workerClient, err = worker.NewClient(cfg.Internal.WorkerURL, cfg.Internal.SharedSecret)
		if err != nil {
			log.Fatalf("failed to create worker client: %v", err)
		}
	}

	var appRunnerClient *apprunnerclient.Client
	if role == "api" {
		if cfg.Internal.AppRunnerURL == "" {
			log.Fatalf("internal.app_runner_url is required for api role")
		}
		appRunnerClient, err = apprunnerclient.New(cfg.Internal.AppRunnerURL, cfg.Internal.AppRunnerSharedSecret)
		if err != nil {
			log.Fatalf("failed to create app-runner client: %v", err)
		}
	}

	options := httpapi.Options{Role: role}
	switch role {
	case "api":
		options.TrustGatewayHeaders = true
	case "auth":
		options.AuthService = true
	case "all":
	default:
		log.Fatalf("unknown service role %q", role)
	}

	app := httpapi.NewAppWithOptions(httpapi.Dependencies{
		Config:   cfg,
		Store:    db,
		Runtime:  sshRuntime,
		Scripts:  catalog,
		Signer:   signerClient,
		Worker:   workerClient,
		AppPlans: appRunnerClient,
		Versions: versionStore,
		Audit:    auditStore,
		Feedback: feedbackStore,
	}, options)
	if role == "api" {
		app.StartVulnerabilityUpdateScheduler(ctx)
		app.StartBatchScriptScheduler(ctx)
		app.StartBackupScheduler(ctx)
	}

	server := &http.Server{
		Addr:              cfg.App.ListenAddr,
		Handler:           app.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		MaxHeaderBytes:    httplimits.MaxHeaderBytes,
	}

	go func() {
		log.Printf("ShellOrchestra %s service listening on %s", role, cfg.App.ListenAddr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http server failed: %v", err)
		}
	}()

	<-ctx.Done()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	sshRuntime.Close()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("http shutdown error: %v", err)
	}
}

func siblingDatabasePath(mainPath string, name string) string {
	return filepath.Join(filepath.Dir(mainPath), name)
}

func runTerminalProxy(socketPath string, tokenFile string) error {
	socketPath = strings.TrimSpace(socketPath)
	tokenFile = strings.TrimSpace(tokenFile)
	if socketPath == "" {
		return fmt.Errorf("terminal bridge socket is required")
	}
	if tokenFile == "" {
		return fmt.Errorf("terminal bridge token file is required")
	}
	token, err := readTerminalBridgeToken(tokenFile)
	if err != nil {
		return err
	}
	if token == "" {
		return fmt.Errorf("terminal bridge token file is empty")
	}
	restoreTerminal, err := enterRawTerminalMode(int(os.Stdin.Fd()))
	if err != nil {
		return err
	}
	defer restoreTerminal()

	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := io.WriteString(conn, token+"\n"); err != nil {
		return err
	}
	go func() {
		_, _ = io.Copy(conn, os.Stdin)
	}()
	_, err = io.Copy(os.Stdout, conn)
	return err
}

func runTerminalOutputProxy(socketPath string, tokenFile string) error {
	socketPath = strings.TrimSpace(socketPath)
	tokenFile = strings.TrimSpace(tokenFile)
	if socketPath == "" {
		return fmt.Errorf("terminal bridge socket is required")
	}
	if tokenFile == "" {
		return fmt.Errorf("terminal bridge token file is required")
	}
	token, err := readTerminalBridgeToken(tokenFile)
	if err != nil {
		return err
	}
	if token == "" {
		return fmt.Errorf("terminal bridge token file is empty")
	}
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := io.WriteString(conn, "output "+token+"\n"); err != nil {
		return err
	}
	_, err = io.Copy(conn, os.Stdin)
	return err
}

func readTerminalBridgeToken(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	var buffer bytes.Buffer
	if _, err := io.Copy(&buffer, io.LimitReader(file, maxTerminalBridgeTokenBytes+1)); err != nil {
		return "", err
	}
	if int64(buffer.Len()) > maxTerminalBridgeTokenBytes {
		return "", fmt.Errorf("terminal bridge token file exceeds %d bytes", maxTerminalBridgeTokenBytes)
	}
	return strings.TrimSpace(buffer.String()), nil
}
