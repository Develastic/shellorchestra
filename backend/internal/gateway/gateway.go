// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package gateway

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"

	"shellorchestra/backend/internal/config"
	"shellorchestra/backend/internal/devicesig"
	"shellorchestra/backend/internal/httplimits"
	"shellorchestra/backend/internal/httpsecurity"
	"shellorchestra/backend/internal/internaljson"
	"shellorchestra/backend/internal/internalurl"
	"shellorchestra/backend/internal/serviceinfo"
)

const (
	maxGatewayBody                = 16 << 20
	maxGatewayStreamingUploadBody = int64(8 * 1024 * 1024 * 1024)
	maxGatewayVerifyResponseBody  = 1 << 20
	userActivityHeader            = "X-ShellOrchestra-User-Activity"
)

type Server struct {
	cfg     config.AppConfig
	auth    *url.URL
	api     *url.URL
	static  *url.URL
	client  *http.Client
	limiter *rateLimiter
}

type verifyResponse struct {
	Principal struct {
		DeviceID                  string `json:"device_id"`
		Label                     string `json:"label"`
		Kind                      string `json:"kind"`
		CanApproveDeviceRequests  bool   `json:"can_approve_device_requests"`
		SessionIdleTimeoutSeconds int    `json:"session_idle_timeout_seconds"`
	} `json:"principal"`
	SessionMaxAgeSeconds int `json:"session_max_age_seconds"`
}

func New(cfg config.AppConfig) (*Server, error) {
	if strings.TrimSpace(cfg.Internal.SharedSecret) == "" {
		return nil, fmt.Errorf("internal.shared_secret is required for security-gateway")
	}
	authURL, err := requiredURL(cfg.Internal.AuthURL, "internal.auth_url")
	if err != nil {
		return nil, err
	}
	apiURL, err := requiredURL(cfg.Internal.APIURL, "internal.api_url")
	if err != nil {
		return nil, err
	}
	staticURL, err := requiredURL(cfg.Internal.StaticURL, "internal.static_url")
	if err != nil {
		return nil, err
	}
	return &Server{
		cfg:     cfg,
		auth:    authURL,
		api:     apiURL,
		static:  staticURL,
		client:  &http.Client{Timeout: 10 * time.Second},
		limiter: newRateLimiter(time.Minute),
	}, nil
}

func requiredURL(raw string, field string) (*url.URL, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, fmt.Errorf("%s is required for gateway role", field)
	}
	return internalurl.ParseServiceURL(raw, field)
}

func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(s.serveHTTP)
}

func (s *Server) serveHTTP(w http.ResponseWriter, r *http.Request) {
	if err := httpsecurity.ValidateRequestPath(r); err != nil {
		writeGatewayError(w, http.StatusBadRequest, "Request path is not normalized.")
		return
	}
	if r.URL.Path == "/internal/service/status" {
		serviceinfo.Handler(s.cfg, "security-gateway", nil).ServeHTTP(w, r)
		return
	}
	if s.streamingUploadAPIPath(r.URL.Path) {
		if !s.boundRequestBodyWithLimit(w, r, maxGatewayStreamingUploadBody) {
			return
		}
		stripInternalHeaders(r.Header)
		s.proxyTo(s.api).ServeHTTP(w, r)
		return
	}
	if !s.boundRequestBody(w, r) {
		return
	}
	stripInternalHeaders(r.Header)
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		s.proxyTo(s.static).ServeHTTP(w, r)
		return
	}
	if isAuthServicePath(r.URL.Path) {
		if publicAPIPath(r.URL.Path) || relaxedAuthPath(r.URL.Path) {
			if !s.allowPublicAuthRequest(r) {
				writeGatewayError(w, http.StatusTooManyRequests, "Too many authentication requests. Please wait and try again.")
				return
			}
			s.proxyTo(s.auth).ServeHTTP(w, r)
			return
		}
		verified, body, ok := s.verifyPrivateRequest(w, r)
		if !ok {
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		s.addVerifiedHeaders(r, verified)
		s.proxyTo(s.auth).ServeHTTP(w, r)
		return
	}
	if publicAPIPath(r.URL.Path) || cookieAuthenticatedAPIRequest(r) {
		s.proxyTo(s.api).ServeHTTP(w, r)
		return
	}
	verified, body, ok := s.verifyPrivateRequest(w, r)
	if !ok {
		return
	}
	if s.shouldRelayDebugFeedback(r) {
		s.relayDebugFeedback(w, r, verified, body)
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	s.addVerifiedHeaders(r, verified)
	s.proxyTo(s.api).ServeHTTP(w, r)
}

func (s *Server) shouldRelayDebugFeedback(r *http.Request) bool {
	return r.Method == http.MethodPost &&
		r.URL.Path == "/api/debug/feedback" &&
		strings.TrimSpace(s.cfg.Feedback.RelayURL) != "" &&
		strings.TrimSpace(s.cfg.Feedback.Project) != ""
}

func (s *Server) streamingUploadAPIPath(path string) bool {
	return strings.HasPrefix(path, "/api/vulnerability-scan/client-upload/")
}

func (s *Server) relayDebugFeedback(w http.ResponseWriter, r *http.Request, verified verifyResponse, body []byte) {
	var incoming struct {
		Message           string `json:"message"`
		PageURL           string `json:"page_url"`
		UserAgent         string `json:"user_agent"`
		ScreenshotPNGB64  string `json:"screenshot_png_b64"`
		ScreenshotDataURL string `json:"screenshot_data_url"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&incoming); err != nil {
		writeGatewayError(w, http.StatusBadRequest, "Debug feedback request is invalid.")
		return
	}
	var trailing struct{}
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeGatewayError(w, http.StatusBadRequest, "Debug feedback request must contain exactly one JSON object.")
		return
	}
	relayBody, err := json.Marshal(map[string]any{
		"project":             strings.TrimSpace(s.cfg.Feedback.Project),
		"message":             incoming.Message,
		"page_url":            incoming.PageURL,
		"user_agent":          incoming.UserAgent,
		"screenshot_png_b64":  incoming.ScreenshotPNGB64,
		"screenshot_data_url": incoming.ScreenshotDataURL,
		"metadata": map[string]string{
			"source":       "shellorchestra.debug_feedback",
			"device_id":    verified.Principal.DeviceID,
			"device_label": verified.Principal.Label,
			"device_kind":  verified.Principal.Kind,
			"relay":        "security-gateway",
		},
	})
	if err != nil {
		writeGatewayError(w, http.StatusInternalServerError, "Debug feedback relay request could not be prepared.")
		return
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, strings.TrimSpace(s.cfg.Feedback.RelayURL), bytes.NewReader(relayBody))
	if err != nil {
		writeGatewayError(w, http.StatusBadGateway, "Shared tickets service URL is invalid.")
		return
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := s.client.Do(request)
	if err != nil {
		log.Printf("debug feedback relay failed: target=%s error=%v", strings.TrimSpace(s.cfg.Feedback.RelayURL), err)
		writeGatewayError(w, http.StatusBadGateway, "ShellOrchestra could not reach the shared tickets service.")
		return
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxGatewayVerifyResponseBody))
	if err != nil {
		writeGatewayError(w, http.StatusBadGateway, "ShellOrchestra could not read the shared tickets service response.")
		return
	}
	w.Header().Set("Content-Type", response.Header.Get("Content-Type"))
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(responseBody)
}

func (s *Server) boundRequestBody(w http.ResponseWriter, r *http.Request) bool {
	if r.ContentLength > maxGatewayBody {
		writeGatewayError(w, http.StatusRequestEntityTooLarge, "Request body is too large.")
		return false
	}
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, maxGatewayBody)
	}
	return true
}

func (s *Server) boundRequestBodyWithLimit(w http.ResponseWriter, r *http.Request, limit int64) bool {
	if r.ContentLength > limit {
		writeGatewayError(w, http.StatusRequestEntityTooLarge, "Request body is too large.")
		return false
	}
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, limit)
	}
	return true
}

func (s *Server) verifyPrivateRequest(w http.ResponseWriter, r *http.Request) (verifyResponse, []byte, bool) {
	if !s.allowPrivateVerifyRequest(r) {
		s.logVerifyFailure(r, "rate_limited", http.StatusTooManyRequests, "")
		writeGatewayError(w, http.StatusTooManyRequests, "Too many signed API requests. Please wait and try again.")
		return verifyResponse{}, nil, false
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxGatewayBody))
	if err != nil {
		s.logVerifyFailure(r, "body_too_large", http.StatusRequestEntityTooLarge, err.Error())
		writeGatewayError(w, http.StatusRequestEntityTooLarge, "Request body is too large.")
		return verifyResponse{}, nil, false
	}
	bodyHash := devicesig.BodyHash(body)
	if header := strings.TrimSpace(r.Header.Get(devicesig.HeaderBodyHash)); header == "" || header != bodyHash {
		s.logVerifyFailure(r, "body_hash_mismatch", http.StatusForbidden, "")
		writeGatewayError(w, http.StatusForbidden, "Request body hash is missing or does not match.")
		return verifyResponse{}, nil, false
	}
	accessCookie, _ := r.Cookie(s.cfg.Security.AccessCookie)
	csrfCookie, _ := r.Cookie(s.cfg.Security.CSRFCookie)
	accessToken := ""
	csrfToken := ""
	if accessCookie != nil {
		accessToken = accessCookie.Value
	}
	if csrfCookie != nil {
		csrfToken = csrfCookie.Value
	}
	pathQuery := r.URL.RequestURI()
	proof := devicesig.RequestProof{
		Method: r.Method, PathQuery: pathQuery, BodyHash: bodyHash,
		Timestamp: r.Header.Get(devicesig.HeaderTimestamp),
		Nonce:     r.Header.Get(devicesig.HeaderNonce),
		DeviceID:  r.Header.Get(devicesig.HeaderDeviceID),
		SessionID: r.Header.Get(devicesig.HeaderSessionID),
		Signature: r.Header.Get(devicesig.HeaderSignature),
	}
	payload := map[string]any{
		"method": proof.Method, "path_query": proof.PathQuery, "body_hash": proof.BodyHash,
		"timestamp": proof.Timestamp, "nonce": proof.Nonce, "device_id": proof.DeviceID,
		"session_id": proof.SessionID, "signature": proof.Signature,
		"csrf_token": csrfToken, "access_token": accessToken, "mutating": isMutating(r.Method),
		"user_active": requestCarriesUserActivity(r),
	}
	payloadBody, _ := json.Marshal(payload)
	verifyURL := s.auth.ResolveReference(&url.URL{Path: "/internal/auth/verify"})
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, verifyURL.String(), bytes.NewReader(payloadBody))
	if err != nil {
		writeGatewayError(w, http.StatusInternalServerError, "Gateway verification request could not be created.")
		return verifyResponse{}, nil, false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-ShellOrchestra-Internal-Secret", s.cfg.Internal.SharedSecret)
	resp, err := s.client.Do(req)
	if err != nil {
		log.Printf("auth verification failed: %v", err)
		s.logVerifyFailure(r, "auth_verifier_unavailable", http.StatusBadGateway, err.Error())
		writeGatewayError(w, http.StatusBadGateway, "Authentication verifier is unavailable.")
		return verifyResponse{}, nil, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		responseBody, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		s.logVerifyFailure(r, "auth_verifier_rejected", resp.StatusCode, string(responseBody))
		w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(responseBody)
		return verifyResponse{}, nil, false
	}
	var verified verifyResponse
	if err := internaljson.DecodeStrictResponse(resp.Body, maxGatewayVerifyResponseBody, &verified, "authentication verifier response"); err != nil {
		s.logVerifyFailure(r, "auth_verifier_invalid_response", http.StatusBadGateway, err.Error())
		writeGatewayError(w, http.StatusBadGateway, "Authentication verifier returned an invalid response.")
		return verifyResponse{}, nil, false
	}
	if verified.Principal.DeviceID == "" {
		s.logVerifyFailure(r, "auth_verifier_empty_principal", http.StatusBadGateway, "")
		writeGatewayError(w, http.StatusBadGateway, "Authentication verifier returned no principal.")
		return verifyResponse{}, nil, false
	}
	s.refreshClientCookies(w, r, verified)
	return verified, body, true
}

func (s *Server) refreshClientCookies(w http.ResponseWriter, r *http.Request, verified verifyResponse) {
	if verified.SessionMaxAgeSeconds <= 0 {
		return
	}
	accessCookie, err := r.Cookie(s.cfg.Security.AccessCookie)
	if err != nil || strings.TrimSpace(accessCookie.Value) == "" {
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     s.cfg.Security.AccessCookie,
		Value:    accessCookie.Value,
		Path:     "/",
		MaxAge:   verified.SessionMaxAgeSeconds,
		HttpOnly: true,
		Secure:   s.cfg.Security.SecureCookies,
		SameSite: http.SameSiteLaxMode,
	})
	if csrfCookie, err := r.Cookie(s.cfg.Security.CSRFCookie); err == nil && strings.TrimSpace(csrfCookie.Value) != "" {
		http.SetCookie(w, &http.Cookie{
			Name:     s.cfg.Security.CSRFCookie,
			Value:    csrfCookie.Value,
			Path:     "/",
			MaxAge:   verified.SessionMaxAgeSeconds,
			HttpOnly: false,
			Secure:   s.cfg.Security.SecureCookies,
			SameSite: http.SameSiteLaxMode,
		})
	}
}

func (s *Server) logVerifyFailure(r *http.Request, reason string, status int, detail string) {
	detail = strings.TrimSpace(detail)
	if len(detail) > 500 {
		detail = detail[:500]
	}
	log.Printf(
		"ShellOrchestra gateway-verify-failed method=%q path=%q status=%d reason=%q client=%q device_id_present=%t session_id_present=%t body_hash_present=%t signature_present=%t detail=%q",
		r.Method,
		r.URL.RequestURI(),
		status,
		reason,
		clientAddress(r),
		strings.TrimSpace(r.Header.Get(devicesig.HeaderDeviceID)) != "",
		strings.TrimSpace(r.Header.Get(devicesig.HeaderSessionID)) != "",
		strings.TrimSpace(r.Header.Get(devicesig.HeaderBodyHash)) != "",
		strings.TrimSpace(r.Header.Get(devicesig.HeaderSignature)) != "",
		detail,
	)
}

func (s *Server) allowPublicAuthRequest(r *http.Request) bool {
	return s.allowRateLimitedRequest("public-auth", r, s.cfg.Gateway.PublicAuthRatePerMinute)
}

func (s *Server) allowPrivateVerifyRequest(r *http.Request) bool {
	return s.allowRateLimitedRequest("private-verify", r, s.cfg.Gateway.PrivateVerifyRatePerMinute)
}

func (s *Server) allowRateLimitedRequest(scope string, r *http.Request, limit int) bool {
	if limit <= 0 {
		return true
	}
	if s.limiter == nil {
		return false
	}
	return s.limiter.Allow(scope+":"+clientAddress(r), limit, time.Now())
}

type rateLimiter struct {
	mu     sync.Mutex
	window time.Duration
	items  map[string]rateLimitItem
}

type rateLimitItem struct {
	windowStart time.Time
	count       int
}

func newRateLimiter(window time.Duration) *rateLimiter {
	return &rateLimiter{window: window, items: map[string]rateLimitItem{}}
}

func (l *rateLimiter) Allow(key string, limit int, now time.Time) bool {
	if limit <= 0 {
		return true
	}
	key = strings.TrimSpace(key)
	if key == "" {
		key = "unknown"
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.window <= 0 {
		l.window = time.Minute
	}
	for itemKey, item := range l.items {
		if now.Sub(item.windowStart) > 2*l.window {
			delete(l.items, itemKey)
		}
	}
	item := l.items[key]
	if item.windowStart.IsZero() || now.Sub(item.windowStart) >= l.window || now.Before(item.windowStart) {
		l.items[key] = rateLimitItem{windowStart: now, count: 1}
		return true
	}
	if item.count >= limit {
		return false
	}
	item.count++
	l.items[key] = item
	return true
}

func clientAddress(r *http.Request) string {
	addr := strings.TrimSpace(r.RemoteAddr)
	if addr == "" {
		return "unknown"
	}
	host, _, err := net.SplitHostPort(addr)
	if err == nil && strings.TrimSpace(host) != "" {
		return host
	}
	return addr
}

func (s *Server) addVerifiedHeaders(r *http.Request, verified verifyResponse) {
	stripInternalHeaders(r.Header)
	r.Header.Set("X-ShellOrchestra-Verified", "1")
	r.Header.Set("X-ShellOrchestra-Principal-Device-ID", verified.Principal.DeviceID)
	r.Header.Set("X-ShellOrchestra-Principal-Label", verified.Principal.Label)
	r.Header.Set("X-ShellOrchestra-Principal-Kind", verified.Principal.Kind)
	r.Header.Set("X-ShellOrchestra-Internal-Secret", s.cfg.Internal.SharedSecret)
}

func stripInternalHeaders(header http.Header) {
	for name := range header {
		if strings.HasPrefix(strings.ToLower(name), "x-shellorchestra-principal-") || strings.EqualFold(name, "X-ShellOrchestra-Verified") || strings.EqualFold(name, "X-ShellOrchestra-Internal-Secret") {
			header.Del(name)
		}
	}
}

func requestCarriesUserActivity(r *http.Request) bool {
	value := strings.TrimSpace(strings.ToLower(r.Header.Get(userActivityHeader)))
	return value == "1" || value == "true"
}

func (s *Server) proxyTo(target *url.URL) http.Handler {
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.FlushInterval = -1
	originalDirector := proxy.Director
	proxy.Director = func(r *http.Request) {
		forwarded := sanitizedForwardedContext(r)
		originalDirector(r)
		applyForwardedContext(r, forwarded)
		r.Host = target.Host
	}
	proxy.ModifyResponse = compressedProxyResponse
	return proxy
}

type forwardedContext struct {
	Host   string
	Proto  string
	RealIP string
}

func sanitizedForwardedContext(r *http.Request) forwardedContext {
	ctx := forwardedContext{
		Host:   strings.TrimSpace(r.Host),
		Proto:  directRequestProto(r),
		RealIP: clientAddress(r),
	}
	if trustedForwardedHeaderSource(r) {
		if proto := trustedForwardedProto(r); proto != "" {
			ctx.Proto = proto
		}
		if host := trustedForwardedHost(r); host != "" {
			ctx.Host = host
		}
		if realIP := trustedForwardedClientIP(r); realIP != "" {
			ctx.RealIP = realIP
		}
	}
	return ctx
}

func applyForwardedContext(r *http.Request, ctx forwardedContext) {
	stripForwardedHeaders(r.Header)
	if ctx.Host != "" {
		r.Header.Set("X-Forwarded-Host", ctx.Host)
	}
	if ctx.Proto == "http" || ctx.Proto == "https" {
		r.Header.Set("X-Forwarded-Proto", ctx.Proto)
	}
	if ctx.RealIP != "" && ctx.RealIP != "unknown" {
		r.Header.Set("X-Real-IP", ctx.RealIP)
		r.Header.Set("X-Forwarded-For", ctx.RealIP)
	}
}

func stripForwardedHeaders(header http.Header) {
	for _, name := range []string{"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP"} {
		header.Del(name)
	}
}

func trustedForwardedHeaderSource(r *http.Request) bool {
	ip := net.ParseIP(clientAddress(r))
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate())
}

func trustedForwardedClientIP(r *http.Request) string {
	for _, value := range r.Header.Values("X-Forwarded-For") {
		for _, part := range strings.Split(value, ",") {
			if ip := net.ParseIP(strings.TrimSpace(part)); ip != nil {
				return ip.String()
			}
		}
	}
	if ip := net.ParseIP(strings.TrimSpace(r.Header.Get("X-Real-IP"))); ip != nil {
		return ip.String()
	}
	return ""
}

func directRequestProto(r *http.Request) string {
	if r.TLS != nil {
		return "https"
	}
	return "http"
}

func trustedForwardedProto(r *http.Request) string {
	if proto := firstHeaderValue(r.Header.Get("X-Forwarded-Proto")); proto == "http" || proto == "https" {
		return proto
	}
	for _, part := range strings.Split(r.Header.Get("Forwarded"), ";") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok || !strings.EqualFold(key, "proto") {
			continue
		}
		value = strings.Trim(strings.TrimSpace(value), `"`)
		if value == "http" || value == "https" {
			return value
		}
	}
	return ""
}

func trustedForwardedHost(r *http.Request) string {
	if host := firstHeaderValue(r.Header.Get("X-Forwarded-Host")); validForwardedHost(host) {
		return host
	}
	for _, part := range strings.Split(r.Header.Get("Forwarded"), ";") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok || !strings.EqualFold(key, "host") {
			continue
		}
		value = strings.Trim(strings.TrimSpace(value), `"`)
		if validForwardedHost(value) {
			return value
		}
	}
	return ""
}

func validForwardedHost(host string) bool {
	host = strings.TrimSpace(host)
	if host == "" || len(host) > 255 {
		return false
	}
	for _, item := range host {
		if item <= 0x20 || item == 0x7f || item == '/' || item == '\\' || item == '@' {
			return false
		}
	}
	return true
}

func firstHeaderValue(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	first, _, _ := strings.Cut(value, ",")
	return strings.ToLower(strings.TrimSpace(first))
}

func compressedProxyResponse(response *http.Response) error {
	encoding := proxyCompressionEncoding(response)
	if encoding == "" {
		return nil
	}
	originalBody := response.Body
	reader, writer := io.Pipe()
	var closeCompressedWriter func() error
	var compressedWriter io.Writer
	switch encoding {
	case "zstd":
		zstdWriter, err := zstd.NewWriter(writer, zstd.WithEncoderLevel(zstd.SpeedFastest))
		if err != nil {
			return err
		}
		compressedWriter = zstdWriter
		closeCompressedWriter = zstdWriter.Close
	case "gzip":
		gzipWriter, err := gzip.NewWriterLevel(writer, gzip.BestSpeed)
		if err != nil {
			return err
		}
		compressedWriter = gzipWriter
		closeCompressedWriter = gzipWriter.Close
	default:
		return nil
	}
	go func() {
		copyErr := copyProxyBodyFlushed(compressedWriter, originalBody)
		closeErr := closeCompressedWriter()
		bodyErr := originalBody.Close()
		if copyErr != nil {
			_ = writer.CloseWithError(copyErr)
			return
		}
		if closeErr != nil {
			_ = writer.CloseWithError(closeErr)
			return
		}
		_ = writer.CloseWithError(bodyErr)
	}()
	response.Body = reader
	response.Header.Del("Content-Length")
	response.Header.Set("Content-Encoding", encoding)
	response.Header.Add("Vary", "Accept-Encoding")
	response.ContentLength = -1
	return nil
}

func copyProxyBodyFlushed(writer io.Writer, reader io.Reader) error {
	buffer := make([]byte, 32*1024)
	for {
		read, readErr := reader.Read(buffer)
		if read > 0 {
			if _, writeErr := writer.Write(buffer[:read]); writeErr != nil {
				return writeErr
			}
			if flushErr := flushProxyCompressionWriter(writer); flushErr != nil {
				return flushErr
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return nil
			}
			return readErr
		}
	}
}

func flushProxyCompressionWriter(writer io.Writer) error {
	if writer == nil {
		return nil
	}
	if flusher, ok := writer.(interface{ Flush() error }); ok {
		return flusher.Flush()
	}
	if flusher, ok := writer.(interface{ Flush() }); ok {
		flusher.Flush()
	}
	return nil
}

func proxyCompressionEncoding(response *http.Response) string {
	if response == nil || response.Request == nil {
		return ""
	}
	if response.Request.Method == http.MethodHead {
		return ""
	}
	encoding := preferredClientCompression(response.Request.Header.Get("Accept-Encoding"))
	if encoding == "" {
		return ""
	}
	if response.StatusCode < 200 || response.StatusCode == http.StatusNoContent || response.StatusCode == http.StatusNotModified || response.StatusCode == http.StatusSwitchingProtocols {
		return ""
	}
	if response.Header.Get("Content-Encoding") != "" {
		return ""
	}
	if response.ContentLength > 0 && response.ContentLength < 1024 {
		return ""
	}
	contentType := strings.ToLower(response.Header.Get("Content-Type"))
	if strings.HasPrefix(contentType, "application/json") ||
		strings.HasPrefix(contentType, "application/x-ndjson") ||
		strings.HasPrefix(contentType, "application/json-seq") ||
		strings.HasPrefix(contentType, "text/") ||
		strings.Contains(contentType, "javascript") ||
		strings.Contains(contentType, "svg+xml") ||
		strings.Contains(contentType, "manifest+json") ||
		strings.Contains(contentType, "wasm") {
		return encoding
	}
	return ""
}

func preferredClientCompression(header string) string {
	acceptsGzip := false
	for _, part := range strings.Split(header, ",") {
		encoding := strings.ToLower(strings.TrimSpace(strings.Split(part, ";")[0]))
		switch encoding {
		case "zstd":
			return "zstd"
		case "gzip":
			acceptsGzip = true
		}
	}
	if acceptsGzip {
		return "gzip"
	}
	return ""
}

func isAuthServicePath(path string) bool {
	return strings.HasPrefix(path, "/api/auth/") || strings.HasPrefix(path, "/api/device-requests") || path == "/api/bootstrap/state"
}

func cookieAuthenticatedAPIRequest(r *http.Request) bool {
	return r.Method == http.MethodGet && (r.URL.Path == "/api/settings/wallpaper/custom" || strings.HasPrefix(r.URL.Path, "/api/desktop-wallpapers/") || isTerminalStreamPath(r.URL.Path))
}

func isTerminalStreamPath(path string) bool {
	if !strings.HasPrefix(path, "/api/terminals/") {
		return false
	}
	return strings.HasSuffix(path, "/stream")
}

func publicAPIPath(path string) bool {
	if path == "/api/healthz" || path == "/api/bootstrap/state" {
		return true
	}
	if isTerminalStreamPath(path) {
		return true
	}
	if path == "/api/auth/debug/login" || path == "/api/debug/payload" {
		return true
	}
	if strings.HasPrefix(path, "/api/vulnerability-scan/client-upload/") {
		return true
	}
	return strings.HasPrefix(path, "/api/auth/passkey/") || strings.HasPrefix(path, "/api/auth/lan/") || strings.HasPrefix(path, "/api/auth/device-requests/")
}

func relaxedAuthPath(path string) bool {
	return path == "/api/auth/me" || path == "/api/auth/logout" || path == "/api/auth/device-signing-key" || path == "/api/auth/device-envelope-key"
}

func isMutating(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}

func writeGatewayError(w http.ResponseWriter, status int, message string) {
	httpsecurity.ApplyBrowserSecurityHeaders(w.Header())
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func ListenAndServe(ctx context.Context, cfg config.AppConfig) error {
	server, err := New(cfg)
	if err != nil {
		return err
	}
	httpServer := &http.Server{Addr: cfg.Gateway.ListenAddr, Handler: server.Handler(), ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: httplimits.MaxHeaderBytes}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()
	log.Printf("ShellOrchestra security gateway listening on %s", cfg.Gateway.ListenAddr)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}
