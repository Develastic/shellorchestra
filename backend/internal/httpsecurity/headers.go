// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package httpsecurity

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode"
)

const (
	CSPNoncePlaceholder = "__SHELLORCHESTRA_CSP_NONCE__"

	contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
)

// ApplyBrowserSecurityHeaders sets browser defense-in-depth headers for all public app responses.
func ApplyBrowserSecurityHeaders(header http.Header) {
	ApplyBrowserSecurityHeadersWithNonce(header, "")
}

// NewCSPNonce returns a nonce suitable for one HTML response.
func NewCSPNonce() (string, error) {
	var raw [18]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("generate CSP nonce: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

// ApplyBrowserSecurityHeadersWithNonce sets browser defense-in-depth headers and allows nonce-bound style tags.
func ApplyBrowserSecurityHeadersWithNonce(header http.Header, nonce string) {
	header.Set("Content-Security-Policy", ContentSecurityPolicy(nonce))
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=()")
}

// ApplySandboxedEditorSecurityHeadersWithNonce sets headers for the isolated Monaco editor iframe.
//
// Monaco 0.55 injects runtime style elements without exposing a typed nonce option.
// The editor route is loaded only inside a sandboxed iframe without allow-same-origin,
// so inline style elements are allowed for this route while the main SPA shell stays
// nonce-only for style elements.
func ApplySandboxedEditorSecurityHeadersWithNonce(header http.Header, nonce string) {
	header.Set("Content-Security-Policy", SandboxedEditorContentSecurityPolicy(nonce))
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=()")
}

// ContentSecurityPolicy returns the CSP for a response. HTML responses receive a nonce for Emotion/MUI style tags.
func ContentSecurityPolicy(nonce string) string {
	nonce = strings.TrimSpace(nonce)
	if nonce == "" {
		return contentSecurityPolicy
	}
	nonceDirective := "'nonce-" + nonce + "'"
	return "default-src 'self'; script-src 'self'; style-src 'self' " + nonceDirective + "; style-src-elem 'self' " + nonceDirective + "; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
}

// SandboxedEditorContentSecurityPolicy returns the CSP for the editor iframe route.
func SandboxedEditorContentSecurityPolicy(_ string) string {
	return "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; style-src-elem 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
}

// HTMLWithCSPNonce injects the one-response nonce into the SPA shell.
func HTMLWithCSPNonce(content []byte, nonce string) []byte {
	if nonce == "" || !bytes.Contains(content, []byte(CSPNoncePlaceholder)) {
		return content
	}
	return bytes.ReplaceAll(content, []byte(CSPNoncePlaceholder), []byte(nonce))
}

// ValidateRequestPath rejects ambiguous request targets before routing decisions.
func ValidateRequestPath(r *http.Request) error {
	if r == nil || r.URL == nil {
		return errors.New("request URL is missing")
	}
	pathValue := r.URL.Path
	if pathValue == "" || !strings.HasPrefix(pathValue, "/") {
		return errors.New("request path must be absolute")
	}
	if strings.Contains(pathValue, "\\") {
		return errors.New("request path must not contain backslashes")
	}
	for _, item := range pathValue {
		if unicode.IsControl(item) {
			return errors.New("request path must not contain control characters")
		}
	}
	escapedPath := strings.ToLower(r.URL.EscapedPath())
	for _, encoded := range []string{"%00", "%2f", "%5c"} {
		if strings.Contains(escapedPath, encoded) {
			return errors.New("request path must not contain encoded separators or NUL bytes")
		}
	}
	if strings.Contains(pathValue, "//") {
		return errors.New("request path must not contain empty segments")
	}
	for _, segment := range strings.Split(pathValue, "/") {
		if segment == "." || segment == ".." {
			return errors.New("request path must not contain dot segments")
		}
	}
	return nil
}
