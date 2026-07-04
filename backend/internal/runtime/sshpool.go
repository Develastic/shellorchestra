// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package runtime

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"math/big"
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/klauspost/compress/zstd"
	"golang.org/x/crypto/ssh"

	"shellorchestra/backend/internal/domain"
)

type Options struct {
	ConnectTimeout time.Duration
	StatusInterval time.Duration
	CertTTL        time.Duration
}

type CertificateSignerProvider interface {
	Locked(ctx context.Context) (bool, error)
	SignUserCertificate(ctx context.Context, server domain.Server, userKey ssh.PublicKey) (*ssh.Certificate, error)
	ClassicSigner(ctx context.Context) (ssh.Signer, error)
	CustomKeySigner(ctx context.Context, keyID string) (ssh.Signer, error)
}

type SSHRuntime struct {
	connectMu              sync.Mutex
	mu                     sync.RWMutex
	options                Options
	provider               CertificateSignerProvider
	caSigner               ssh.Signer
	classicSigner          ssh.Signer
	clients                map[string]*ssh.Client
	terminalPools          map[string]*SSHTransportPool
	locked                 bool
	allowedSourceAddresses []string
}

const maxTerminalTransportsPerServer = 7
const maxChannelsPerSSHTransport = 8
const powerShellRuntimeMarkerPrefix = "shellorchestra-runtime-"
const powerShellRuntimeCleanupTimeout = 8 * time.Second
const powerShellRuntimeStaleProcessTTL = 2 * time.Hour

type OutputLimits struct {
	MaxStdoutBytes  int64
	MaxStderrBytes  int64
	MaxDecodedBytes int64
}

var preferredSSHCiphers = []string{
	"chacha20-poly1305@openssh.com",
	"aes128-gcm@openssh.com",
	"aes256-gcm@openssh.com",
	"aes128-ctr",
	"aes192-ctr",
	"aes256-ctr",
}

var (
	powerShellEncodedCommandPattern     = regexp.MustCompile(`(?i)-EncodedCommand\s+([A-Za-z0-9+/=]+)`)
	powerShellRuntimeMarkerPattern      = regexp.MustCompile(`SHELLORCHESTRA_RUNTIME_MARKER\s*=\s*'([^']+)'`)
	powerShellRuntimeMarkerValuePattern = regexp.MustCompile(`^shellorchestra-runtime-[A-Za-z0-9_-]{8,128}$`)
)

func sshClientConfig(user string, auth []ssh.AuthMethod, callback ssh.HostKeyCallback, hostKeyAlgorithms []string, timeout time.Duration) *ssh.ClientConfig {
	return &ssh.ClientConfig{
		Config: ssh.Config{
			// Keep SSH compression off and compress only selected high-volume payloads at the application layer.
			Ciphers: preferredSSHCiphers,
		},
		User:              user,
		Auth:              auth,
		HostKeyCallback:   callback,
		HostKeyAlgorithms: hostKeyAlgorithms,
		Timeout:           timeout,
	}
}

type SSHTransportPool struct {
	runtime    *SSHRuntime
	serverID   string
	max        int
	mu         sync.Mutex
	nextID     int
	opening    int
	closed     bool
	transports []*pooledSSHTransport
}

type pooledSSHTransport struct {
	id           int
	client       *ssh.Client
	active       int
	channelLimit int
	closed       bool
}

type TCPTestResult struct {
	Reachable bool     `json:"reachable"`
	Message   string   `json:"message"`
	Verbose   []string `json:"verbose"`
}

type AuthTestResult struct {
	Authenticated    bool              `json:"authenticated"`
	HostKey          string            `json:"host_key"`
	HostKeySHA256    string            `json:"host_key_sha256"`
	HostKeys         []HostKeyIdentity `json:"host_keys,omitempty"`
	HostKeyMismatch  bool              `json:"host_key_mismatch,omitempty"`
	ExpectedHostKeys []HostKeyIdentity `json:"expected_host_keys,omitempty"`
	ActualHostKey    *HostKeyIdentity  `json:"actual_host_key,omitempty"`
	Message          string            `json:"message"`
	Verbose          []string          `json:"verbose"`
}

type HostKeyIdentity struct {
	Type          string `json:"type"`
	SHA256        string `json:"sha256"`
	AuthorizedKey string `json:"authorized_key"`
}

type HostKeyScanResult struct {
	HostKeys []HostKeyIdentity `json:"host_keys"`
	HostKey  string            `json:"host_key"`
	Message  string            `json:"message"`
	Verbose  []string          `json:"verbose"`
}

type HostKeyMismatchError struct {
	Expected []HostKeyIdentity
	Actual   HostKeyIdentity
}

type ShellOptions struct {
	Term   string
	Cols   int
	Rows   int
	Env    map[string]string
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
	Resize <-chan TerminalSize
}

type TerminalSize struct {
	Cols int
	Rows int
}

func (e HostKeyMismatchError) Error() string {
	return fmt.Sprintf("server host key changed: expected %s, got %s", summarizeHostKeyIdentities(e.Expected), e.Actual.SHA256)
}

type TCPDialError struct {
	Err error
}

func (e TCPDialError) Error() string { return e.Err.Error() }

func (e TCPDialError) Unwrap() error { return e.Err }

var ErrNotConnected = errors.New("server is not connected")

func NewSSHRuntime(options Options) *SSHRuntime {
	return &SSHRuntime{options: options, clients: map[string]*ssh.Client{}, terminalPools: map[string]*SSHTransportPool{}, locked: true}
}

func (r *SSHRuntime) UseCertificateSignerProvider(provider CertificateSignerProvider) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.provider = provider
	r.locked = false
}

func (r *SSHRuntime) Locked() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.provider != nil {
		return false
	}
	return r.locked
}

func (r *SSHRuntime) Unlock(caSigner ssh.Signer) {
	r.UnlockAuthoritySigners(caSigner, nil)
}

func (r *SSHRuntime) UnlockAuthoritySigners(caSigner ssh.Signer, classicSigner ssh.Signer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.caSigner = caSigner
	r.classicSigner = classicSigner
	r.locked = false
}

func (r *SSHRuntime) SetAllowedSourceAddresses(addresses []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.allowedSourceAddresses = append([]string(nil), addresses...)
}

func (r *SSHRuntime) SetCertificateTTL(ttl time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.options.CertTTL = ttl
}

func (r *SSHRuntime) Lock() {
	r.mu.Lock()
	r.locked = true
	r.caSigner = nil
	r.classicSigner = nil
	clients := make([]*ssh.Client, 0, len(r.clients))
	for id, client := range r.clients {
		clients = append(clients, client)
		delete(r.clients, id)
	}
	pools := make([]*SSHTransportPool, 0, len(r.terminalPools))
	for id, pool := range r.terminalPools {
		pools = append(pools, pool)
		delete(r.terminalPools, id)
	}
	r.mu.Unlock()
	for _, client := range clients {
		_ = client.Close()
	}
	for _, pool := range pools {
		pool.Close()
	}
}

func (r *SSHRuntime) Close() { r.Lock() }

func (r *SSHRuntime) Disconnect(serverID string) {
	r.mu.Lock()
	client := r.clients[serverID]
	if client != nil {
		delete(r.clients, serverID)
	}
	pool := r.terminalPools[serverID]
	if pool != nil {
		delete(r.terminalPools, serverID)
	}
	r.mu.Unlock()
	if client != nil {
		_ = client.Close()
	}
	if pool != nil {
		pool.Close()
	}
}

func (r *SSHRuntime) disconnectClient(serverID string, client *ssh.Client) {
	if client == nil {
		return
	}
	r.mu.Lock()
	if r.clients[serverID] == client {
		delete(r.clients, serverID)
	}
	r.mu.Unlock()
	_ = client.Close()
}

func (r *SSHRuntime) IsConnected(serverID string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.clients[serverID] != nil
}

func (r *SSHRuntime) KeepAlive(ctx context.Context, serverID string) error {
	r.mu.RLock()
	client := r.clients[serverID]
	locked := r.locked
	provider := r.provider
	r.mu.RUnlock()
	if provider == nil && locked {
		return fmt.Errorf("server access is locked; open ShellOrchestra on an approved device and sign in to unlock server connections")
	}
	if client == nil {
		return ErrNotConnected
	}
	if err := keepAliveClient(ctx, client); err != nil {
		r.disconnectClient(serverID, client)
		return err
	}
	return nil
}

func keepAliveClient(ctx context.Context, client *ssh.Client) error {
	type keepAliveResult struct {
		err error
	}
	done := make(chan keepAliveResult, 1)
	go func() {
		_, _, err := client.SendRequest("keepalive@openssh.com", true, nil)
		done <- keepAliveResult{err: err}
	}()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case result := <-done:
		return result.err
	}
}

func serverLooksLikePowerShell(server domain.Server) bool {
	values := []string{
		server.ShellHint,
		server.OSHint,
		server.DistroHint,
		server.DetectedShell,
		server.DetectedOS,
		server.DetectedDistro,
		server.DetectedPlatform,
		server.DetectedPlatformOS,
		server.OverrideShell,
		server.OverrideOS,
		server.OverrideDistro,
	}
	for _, value := range values {
		normalized := strings.ToLower(strings.TrimSpace(value))
		if normalized == "powershell" || strings.Contains(normalized, "windows") {
			return true
		}
	}
	return false
}

func powerShellRuntimeMarkerFromCommand(command string) string {
	payload, ok := decodePowerShellEncodedCommand(command)
	if !ok {
		return ""
	}
	match := powerShellRuntimeMarkerPattern.FindStringSubmatch(payload)
	if len(match) != 2 {
		return ""
	}
	marker := strings.TrimSpace(match[1])
	if !strings.HasPrefix(marker, powerShellRuntimeMarkerPrefix) || !powerShellRuntimeMarkerValuePattern.MatchString(marker) {
		return ""
	}
	return marker
}

func decodePowerShellEncodedCommand(command string) (string, bool) {
	match := powerShellEncodedCommandPattern.FindStringSubmatch(command)
	if len(match) != 2 {
		return "", false
	}
	raw, err := base64.StdEncoding.DecodeString(match[1])
	if err != nil || len(raw)%2 != 0 {
		return "", false
	}
	words := make([]uint16, 0, len(raw)/2)
	for index := 0; index < len(raw); index += 2 {
		words = append(words, uint16(raw[index])|uint16(raw[index+1])<<8)
	}
	return string(utf16.Decode(words)), true
}

func powerShellRuntimeCleanupCommand(marker string, staleAfter time.Duration) string {
	marker = strings.TrimSpace(marker)
	if !powerShellRuntimeMarkerValuePattern.MatchString(marker) {
		marker = ""
	}
	staleAfterSeconds := int(staleAfter.Seconds())
	if staleAfterSeconds < 60 {
		staleAfterSeconds = int(powerShellRuntimeStaleProcessTTL.Seconds())
	}
	script := fmt.Sprintf(`
$ErrorActionPreference = 'SilentlyContinue'
$currentPid = $PID
$targetMarker = '%s'
$markerPattern = "SHELLORCHESTRA_RUNTIME_MARKER\s*=\s*'(?<marker>shellorchestra-runtime-[A-Za-z0-9_-]+)'"
$cutoff = (Get-Date).ToUniversalTime().AddSeconds(-%d)

function Decode-ShellOrchestraEncodedCommand([string]$commandLine) {
  if ([string]::IsNullOrWhiteSpace($commandLine)) { return '' }
  $match = [regex]::Match($commandLine, '-EncodedCommand\s+([A-Za-z0-9+/=]+)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (-not $match.Success) { return '' }
  try {
    return [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($match.Groups[1].Value))
  } catch {
    return ''
  }
}

Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | ForEach-Object {
  if ($_.ProcessId -eq $currentPid) { return }
  $decoded = Decode-ShellOrchestraEncodedCommand ([string]$_.CommandLine)
  if ([string]::IsNullOrWhiteSpace($decoded)) { return }
  $markerMatch = [regex]::Match($decoded, $markerPattern)
  if (-not $markerMatch.Success) { return }
  $foundMarker = $markerMatch.Groups['marker'].Value
  if ($targetMarker.Length -gt 0) {
    if ($foundMarker -ne $targetMarker) { return }
  } else {
    if ($null -eq $_.CreationDate) { return }
    try {
      $created = [Management.ManagementDateTimeConverter]::ToDateTime($_.CreationDate).ToUniversalTime()
    } catch {
      return
    }
    if ($created -gt $cutoff) { return }
  }
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
`, marker, staleAfterSeconds)
	return powerShellEncodedCommand(script)
}

func powerShellEncodedCommand(script string) string {
	encoded := utf16.Encode([]rune(script))
	data := make([]byte, 0, len(encoded)*2)
	for _, value := range encoded {
		data = append(data, byte(value), byte(value>>8))
	}
	return "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + base64.StdEncoding.EncodeToString(data)
}

func cleanupPowerShellRuntimeProcesses(ctx context.Context, client *ssh.Client, marker string, staleAfter time.Duration) {
	if client == nil {
		return
	}
	session, err := client.NewSession()
	if err != nil {
		return
	}
	defer session.Close()
	done := make(chan error, 1)
	go func() { done <- session.Run(powerShellRuntimeCleanupCommand(marker, staleAfter)) }()
	select {
	case <-ctx.Done():
		_ = session.Signal(ssh.SIGKILL)
		_ = session.Close()
	case <-done:
		return
	}
}

func (r *SSHRuntime) Connect(ctx context.Context, server domain.Server) (domain.ServerStatus, error) {
	r.connectMu.Lock()
	defer r.connectMu.Unlock()

	r.mu.RLock()
	locked := r.locked
	caSigner := r.caSigner
	classicSigner := r.classicSigner
	provider := r.provider
	allowedSourceAddresses := append([]string(nil), r.allowedSourceAddresses...)
	existing := r.clients[server.ID]
	r.mu.RUnlock()
	if provider == nil && locked {
		return status(server.ID, domain.StatusLocked, nil, "SERVER ACCESS IS LOCKED. Open ShellOrchestra on the approved phone and sign in to unlock server connections."), nil
	}
	if provider != nil {
		providerLocked, err := provider.Locked(ctx)
		if err != nil {
			return status(server.ID, domain.StatusFailed, nil, err.Error()), err
		}
		if providerLocked {
			return status(server.ID, domain.StatusLocked, nil, "SERVER ACCESS IS LOCKED. Sign in with an approved device to unlock the ShellOrchestra SSH CA."), nil
		}
	}
	if existing != nil {
		if err := keepAliveClient(ctx, existing); err == nil {
			return status(server.ID, domain.StatusConnected, map[string]any{"connected": true, "reused": true}, ""), nil
		}
		r.disconnectClient(server.ID, existing)
	}
	clientSigners, err := r.clientSignersFor(ctx, server, caSigner, classicSigner, provider, allowedSourceAddresses)
	if err != nil {
		return status(server.ID, domain.StatusFailed, nil, err.Error()), err
	}
	if strings.TrimSpace(server.HostKey) == "" {
		return status(server.ID, domain.StatusHostKeyRequired, nil, "Server host key is required before first connection."), nil
	}
	hostKeys, err := parseHostKeys(server.HostKey)
	if err != nil {
		return status(server.ID, domain.StatusFailed, nil, "Configured host key is invalid."), err
	}
	config := sshClientConfig(server.Username, []ssh.AuthMethod{ssh.PublicKeys(clientSigners...)}, trustedHostKeyCallback(hostKeys), hostKeyAlgorithmsFor(hostKeys), r.options.ConnectTimeout)
	client, err := r.dialSSH(ctx, server, config)
	if err != nil {
		var mismatch HostKeyMismatchError
		if ok := errors.As(err, &mismatch); ok {
			return status(server.ID, domain.StatusHostKeyMismatch, map[string]any{
				"expected_host_keys": mismatch.Expected,
				"actual_host_key":    mismatch.Actual,
			}, "Server identity changed. Review the current host key before connecting."), nil
		}
		return status(server.ID, domain.StatusFailed, nil, err.Error()), err
	}
	r.mu.Lock()
	if old := r.clients[server.ID]; old != nil {
		old.Close()
	}
	r.clients[server.ID] = client
	r.mu.Unlock()
	if serverLooksLikePowerShell(server) {
		go func() {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), powerShellRuntimeCleanupTimeout)
			defer cancel()
			cleanupPowerShellRuntimeProcesses(cleanupCtx, client, "", powerShellRuntimeStaleProcessTTL)
		}()
	}
	telemetry := map[string]any{"connected": true}
	return status(server.ID, domain.StatusConnected, telemetry, ""), nil
}

func (r *SSHRuntime) TestTCP(ctx context.Context, server domain.Server) TCPTestResult {
	verbose := []string{fmt.Sprintf("Checking TCP reachability for %s:%d.", server.Host, server.Port)}
	conn, err := r.dialTCP(ctx, server)
	if err != nil {
		verbose = append(verbose, err.Error())
		return TCPTestResult{Reachable: false, Message: tcpFailureMessage(server, err), Verbose: verbose}
	}
	_ = conn.Close()
	verbose = append(verbose, "TCP connection opened successfully.")
	return TCPTestResult{Reachable: true, Message: "TCP connection is open. Click Next to continue.", Verbose: verbose}
}

func (r *SSHRuntime) TestAuth(ctx context.Context, server domain.Server) AuthTestResult {
	verbose := []string{
		fmt.Sprintf("Testing SSH authentication for %s@%s:%d.", server.Username, server.Host, server.Port),
		fmt.Sprintf("Selected authentication method: %s.", server.AuthMethod),
	}
	r.mu.RLock()
	locked := r.locked
	caSigner := r.caSigner
	classicSigner := r.classicSigner
	provider := r.provider
	allowedSourceAddresses := append([]string(nil), r.allowedSourceAddresses...)
	r.mu.RUnlock()
	if provider == nil && locked {
		return AuthTestResult{Authenticated: false, Message: "Server access is locked in this backend runtime. Unlock server access before testing SSH authentication.", Verbose: append(verbose, "Runtime is locked.")}
	}
	if provider != nil {
		providerLocked, err := provider.Locked(ctx)
		if err != nil {
			return AuthTestResult{Authenticated: false, Message: err.Error(), Verbose: append(verbose, err.Error())}
		}
		if providerLocked {
			return AuthTestResult{Authenticated: false, Message: "ShellOrchestra SSH signer is locked in this backend runtime. Unlock server access before testing SSH authentication.", Verbose: append(verbose, "CA signer is locked.")}
		}
	}
	clientSigners, err := r.clientSignersFor(ctx, server, caSigner, classicSigner, provider, allowedSourceAddresses)
	if err != nil {
		return AuthTestResult{Authenticated: false, Message: err.Error(), Verbose: append(verbose, err.Error())}
	}
	var capturedHostKey ssh.PublicKey
	var mismatchDetails *HostKeyMismatchError
	hostKeys, parseErr := parseHostKeys(server.HostKey)
	if parseErr != nil {
		return AuthTestResult{Authenticated: false, Message: "Configured host key is invalid.", Verbose: append(verbose, parseErr.Error())}
	}
	config := sshClientConfig(server.Username, []ssh.AuthMethod{ssh.PublicKeys(clientSigners...)}, func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		capturedHostKey = key
		if len(hostKeys) == 0 {
			return nil
		}
		if hostKeyTrusted(hostKeys, key) {
			return nil
		}
		mismatch := HostKeyMismatchError{Expected: identitiesFor(hostKeys), Actual: identityFor(key)}
		mismatchDetails = &mismatch
		return mismatch
	}, hostKeyAlgorithmsFor(hostKeys), r.options.ConnectTimeout)
	client, err := r.dialSSH(ctx, server, config)
	if err != nil {
		result := AuthTestResult{Authenticated: false, Message: err.Error(), Verbose: append(verbose, err.Error())}
		if mismatchDetails != nil {
			result.HostKeyMismatch = true
			result.ExpectedHostKeys = mismatchDetails.Expected
			result.ActualHostKey = &mismatchDetails.Actual
			result.Message = "Server identity changed. Review the current host key before connecting."
		}
		if capturedHostKey != nil {
			identity := identityFor(capturedHostKey)
			result.HostKey = identity.AuthorizedKey
			result.HostKeySHA256 = identity.SHA256
			result.HostKeys = []HostKeyIdentity{identity}
		}
		return result
	}
	_ = client.Close()
	hostKey := ""
	hostKeySHA256 := ""
	hostKeyIdentities := []HostKeyIdentity{}
	if scan := r.ScanHostKeys(ctx, server); len(scan.HostKeys) > 0 {
		hostKey = scan.HostKey
		hostKeyIdentities = scan.HostKeys
		hostKeySHA256 = summarizeHostKeyIdentities(scan.HostKeys)
		verbose = append(verbose, scan.Verbose...)
	}
	if capturedHostKey != nil {
		identity := identityFor(capturedHostKey)
		if hostKey == "" {
			hostKey = identity.AuthorizedKey
			hostKeySHA256 = identity.SHA256
			hostKeyIdentities = []HostKeyIdentity{identity}
		}
		verbose = append(verbose, "Captured host key: "+hostKeySHA256)
	}
	verbose = append(verbose, "SSH authentication succeeded.")
	return AuthTestResult{Authenticated: true, HostKey: hostKey, HostKeySHA256: hostKeySHA256, HostKeys: hostKeyIdentities, Message: "SSH authentication succeeded.", Verbose: verbose}
}

func (r *SSHRuntime) ScanHostKeys(ctx context.Context, server domain.Server) HostKeyScanResult {
	verbose := []string{fmt.Sprintf("Scanning SSH host keys for %s:%d.", server.Host, server.Port)}
	keys := []ssh.PublicKey{}
	seen := map[string]bool{}
	for _, algorithm := range defaultHostKeyAlgorithms() {
		key, err := r.scanHostKeyForAlgorithm(ctx, server, algorithm)
		if err != nil {
			verbose = append(verbose, fmt.Sprintf("%s: %s", algorithm, err.Error()))
			continue
		}
		keyID := string(key.Marshal())
		if seen[keyID] {
			continue
		}
		seen[keyID] = true
		keys = append(keys, key)
		verbose = append(verbose, fmt.Sprintf("%s: %s", key.Type(), ssh.FingerprintSHA256(key)))
	}
	identities := identitiesFor(keys)
	if len(identities) == 0 {
		return HostKeyScanResult{HostKeys: identities, Message: "No SSH host keys were captured. Check that the endpoint is an SSH server.", Verbose: verbose}
	}
	return HostKeyScanResult{HostKeys: identities, HostKey: marshalHostKeys(keys), Message: fmt.Sprintf("Captured %d SSH host key(s).", len(identities)), Verbose: verbose}
}

func (r *SSHRuntime) scanHostKeyForAlgorithm(ctx context.Context, server domain.Server, algorithm string) (ssh.PublicKey, error) {
	var captured ssh.PublicKey
	conn, err := r.dialTCP(ctx, server)
	if err != nil {
		return nil, TCPDialError{Err: err}
	}
	defer conn.Close()
	config := sshClientConfig("shellorchestra-host-key-scan", []ssh.AuthMethod{}, func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		captured = key
		return nil
	}, []string{algorithm}, r.options.ConnectTimeout)
	address := net.JoinHostPort(server.Host, fmt.Sprintf("%d", server.Port))
	clientConn, _, reqs, err := ssh.NewClientConn(conn, address, config)
	if clientConn != nil {
		_ = clientConn.Close()
	}
	if reqs != nil {
		go ssh.DiscardRequests(reqs)
	}
	if captured != nil {
		return captured, nil
	}
	if err == nil {
		return nil, fmt.Errorf("server did not present a host key")
	}
	return nil, err
}

func parseHostKeys(raw string) ([]ssh.PublicKey, error) {
	lines := strings.Split(raw, "\n")
	keys := make([]ssh.PublicKey, 0, len(lines))
	seen := map[string]bool{}
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(line))
		if err != nil {
			fields := strings.Fields(line)
			if len(fields) >= 3 {
				key, _, _, _, err = ssh.ParseAuthorizedKey([]byte(strings.Join(fields[1:], " ")))
			}
		}
		if err != nil {
			return nil, fmt.Errorf("parse host key %q: %w", line, err)
		}
		keyID := string(key.Marshal())
		if seen[keyID] {
			continue
		}
		seen[keyID] = true
		keys = append(keys, key)
	}
	return keys, nil
}

func marshalHostKeys(keys []ssh.PublicKey) string {
	lines := make([]string, 0, len(keys))
	seen := map[string]bool{}
	for _, key := range keys {
		keyID := string(key.Marshal())
		if seen[keyID] {
			continue
		}
		seen[keyID] = true
		lines = append(lines, string(bytes.TrimSpace(ssh.MarshalAuthorizedKey(key))))
	}
	return strings.Join(lines, "\n")
}

func identitiesFor(keys []ssh.PublicKey) []HostKeyIdentity {
	identities := make([]HostKeyIdentity, 0, len(keys))
	for _, key := range keys {
		identities = append(identities, identityFor(key))
	}
	return identities
}

func identityFor(key ssh.PublicKey) HostKeyIdentity {
	return HostKeyIdentity{
		Type:          key.Type(),
		SHA256:        ssh.FingerprintSHA256(key),
		AuthorizedKey: string(bytes.TrimSpace(ssh.MarshalAuthorizedKey(key))),
	}
}

func trustedHostKeyCallback(expected []ssh.PublicKey) ssh.HostKeyCallback {
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		if hostKeyTrusted(expected, key) {
			return nil
		}
		return HostKeyMismatchError{Expected: identitiesFor(expected), Actual: identityFor(key)}
	}
}

func hostKeyTrusted(expected []ssh.PublicKey, actual ssh.PublicKey) bool {
	for _, key := range expected {
		if bytes.Equal(key.Marshal(), actual.Marshal()) {
			return true
		}
	}
	return false
}

func hostKeyAlgorithmsFor(keys []ssh.PublicKey) []string {
	if len(keys) == 0 {
		return nil
	}
	algorithms := []string{}
	seen := map[string]bool{}
	add := func(value string) {
		if value == "" || seen[value] {
			return
		}
		seen[value] = true
		algorithms = append(algorithms, value)
	}
	for _, key := range keys {
		switch key.Type() {
		case "ssh-rsa":
			add("rsa-sha2-512")
			add("rsa-sha2-256")
			add("ssh-rsa")
		default:
			add(key.Type())
		}
	}
	return algorithms
}

func defaultHostKeyAlgorithms() []string {
	return []string{
		"ssh-ed25519",
		"ecdsa-sha2-nistp256",
		"ecdsa-sha2-nistp384",
		"ecdsa-sha2-nistp521",
		"rsa-sha2-512",
		"rsa-sha2-256",
		"ssh-rsa",
	}
}

func summarizeHostKeyIdentities(identities []HostKeyIdentity) string {
	if len(identities) == 0 {
		return "none"
	}
	parts := make([]string, 0, len(identities))
	for _, identity := range identities {
		parts = append(parts, identity.Type+" "+identity.SHA256)
	}
	return strings.Join(parts, ", ")
}

func (r *SSHRuntime) clientSignersFor(ctx context.Context, server domain.Server, caSigner ssh.Signer, classicSigner ssh.Signer, provider CertificateSignerProvider, allowedSourceAddresses []string) ([]ssh.Signer, error) {
	authMethod := server.AuthMethod
	if authMethod == "" {
		authMethod = domain.ServerAuthCA
	}
	switch authMethod {
	case domain.ServerAuthClassic:
		if provider != nil {
			signer, err := provider.ClassicSigner(ctx)
			if err != nil {
				return nil, err
			}
			return []ssh.Signer{signer}, nil
		}
		if classicSigner == nil {
			return nil, fmt.Errorf("classic SSH fallback key is not unlocked")
		}
		return []ssh.Signer{classicSigner}, nil
	case domain.ServerAuthCustomKey:
		if strings.TrimSpace(server.SSHKeyID) == "" {
			return nil, fmt.Errorf("own key authentication requires a selected SSH key")
		}
		if provider == nil {
			return nil, fmt.Errorf("own key authentication requires the isolated CA signer service")
		}
		signer, err := provider.CustomKeySigner(ctx, server.SSHKeyID)
		if err != nil {
			return nil, err
		}
		return []ssh.Signer{signer}, nil
	case domain.ServerAuthLocalProtectedKey:
		return localProtectedKeySigners(ctx)
	case domain.ServerAuthCA:
		if provider == nil && caSigner == nil {
			return nil, fmt.Errorf("ShellOrchestra SSH CA is not unlocked")
		}
	default:
		return nil, fmt.Errorf("unsupported server authentication method %q", authMethod)
	}
	_, userPrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate ephemeral SSH certificate key: %w", err)
	}
	userSigner, err := ssh.NewSignerFromKey(userPrivateKey)
	if err != nil {
		return nil, fmt.Errorf("create ephemeral SSH certificate signer: %w", err)
	}
	var cert *ssh.Certificate
	if provider != nil {
		cert, err = provider.SignUserCertificate(ctx, server, userSigner.PublicKey())
	} else {
		cert, err = r.signLocalCertificate(server, userSigner.PublicKey(), caSigner, allowedSourceAddresses)
	}
	if err != nil {
		return nil, err
	}
	certSigner, err := ssh.NewCertSigner(cert, userSigner)
	if err != nil {
		return nil, fmt.Errorf("create SSH certificate signer: %w", err)
	}
	return []ssh.Signer{certSigner}, nil
}

func (r *SSHRuntime) dialSSH(ctx context.Context, server domain.Server, config *ssh.ClientConfig) (*ssh.Client, error) {
	conn, err := r.dialTCP(ctx, server)
	if err != nil {
		return nil, TCPDialError{Err: err}
	}
	address := net.JoinHostPort(server.Host, fmt.Sprintf("%d", server.Port))
	clientConn, chans, reqs, err := ssh.NewClientConn(conn, address, config)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	return ssh.NewClient(clientConn, chans, reqs), nil
}

func (r *SSHRuntime) dialTCP(ctx context.Context, server domain.Server) (net.Conn, error) {
	address := net.JoinHostPort(server.Host, fmt.Sprintf("%d", server.Port))
	if server.ConnectionMode == "" || server.ConnectionMode == domain.ServerConnectionDirect {
		dialer := net.Dialer{Timeout: r.options.ConnectTimeout}
		return dialer.DialContext(ctx, "tcp", address)
	}
	if server.ConnectionMode != domain.ServerConnectionChained {
		return nil, fmt.Errorf("unsupported connection mode %q", server.ConnectionMode)
	}
	r.mu.RLock()
	jumpClient := r.clients[strings.TrimSpace(server.JumpServerID)]
	r.mu.RUnlock()
	if jumpClient == nil {
		return nil, fmt.Errorf("jump server is not connected; connect the selected jump server before testing or using this chained target")
	}
	type dialResult struct {
		conn net.Conn
		err  error
	}
	done := make(chan dialResult, 1)
	go func() {
		conn, err := jumpClient.Dial("tcp", address)
		done <- dialResult{conn: conn, err: err}
	}()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case result := <-done:
		return result.conn, result.err
	}
}

func tcpFailureMessage(server domain.Server, err error) string {
	if server.ConnectionMode == domain.ServerConnectionChained {
		return "TCP connection failed from the selected jump server: " + err.Error()
	}
	return "TCP connection failed from the ShellOrchestra backend: " + err.Error()
}

func (r *SSHRuntime) signLocalCertificate(server domain.Server, userKey ssh.PublicKey, caSigner ssh.Signer, allowedSourceAddresses []string) (*ssh.Certificate, error) {
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	ttl := r.options.CertTTL
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	permissions := defaultCertificatePermissions()
	if len(allowedSourceAddresses) > 0 {
		permissions.CriticalOptions = map[string]string{"source-address": strings.Join(allowedSourceAddresses, ",")}
	}
	cert := &ssh.Certificate{
		Nonce:           randomNonce(32),
		Key:             userKey,
		Serial:          serial,
		CertType:        ssh.UserCert,
		KeyId:           "shellorchestra:" + server.ID,
		ValidPrincipals: []string{server.Username},
		ValidAfter:      uint64(now.Add(-30 * time.Second).Unix()),
		ValidBefore:     uint64(now.Add(ttl).Unix()),
		Permissions:     permissions,
	}
	if err := cert.SignCert(rand.Reader, caSigner); err != nil {
		return nil, fmt.Errorf("sign SSH user certificate: %w", err)
	}
	return cert, nil
}

func defaultCertificatePermissions() ssh.Permissions {
	return ssh.Permissions{Extensions: map[string]string{
		"permit-pty":              "",
		"permit-user-rc":          "",
		"permit-port-forwarding":  "",
		"permit-agent-forwarding": "",
	}}
}

func randomSerial() (uint64, error) {
	max := new(big.Int).SetUint64(^uint64(0))
	value, err := rand.Int(rand.Reader, max)
	if err != nil {
		return 0, fmt.Errorf("generate SSH certificate serial: %w", err)
	}
	return value.Uint64(), nil
}

func randomNonce(size int) []byte {
	nonce := make([]byte, size)
	_, _ = rand.Read(nonce)
	return nonce
}

func (r *SSHRuntime) RunJSON(ctx context.Context, serverID string, command string) (map[string]any, error) {
	return r.RunJSONLimited(ctx, serverID, command, OutputLimits{})
}

func (r *SSHRuntime) RunJSONLimited(ctx context.Context, serverID string, command string, limits OutputLimits) (map[string]any, error) {
	stdout := newLimitedStringWriter(effectiveLimit(limits.MaxStdoutBytes, defaultMaxRemoteStdoutBytes))
	stderr := newLimitedStringWriter(effectiveLimit(limits.MaxStderrBytes, defaultMaxRemoteStderrBytes))
	if err := r.RunStream(ctx, serverID, command, nil, &stdout, &stderr); err != nil {
		return nil, remoteCommandError(err, stdout.String(), stderr.String())
	}
	if err := stdout.Err("stdout"); err != nil {
		return nil, err
	}
	if err := stderr.Err("stderr"); err != nil {
		return nil, err
	}
	payload, err := parseRemoteJSONLimited(stdout.String(), limits.MaxDecodedBytes)
	if err != nil && strings.TrimSpace(stdout.String()) == "" {
		r.Disconnect(serverID)
	}
	return payload, err
}

func (r *SSHRuntime) RunJSONWithInput(ctx context.Context, serverID string, command string, stdin io.Reader) (map[string]any, error) {
	return r.RunJSONWithInputLimited(ctx, serverID, command, stdin, OutputLimits{})
}

func (r *SSHRuntime) RunJSONWithInputLimited(ctx context.Context, serverID string, command string, stdin io.Reader, limits OutputLimits) (map[string]any, error) {
	stdout := newLimitedStringWriter(effectiveLimit(limits.MaxStdoutBytes, defaultMaxRemoteStdoutBytes))
	stderr := newLimitedStringWriter(effectiveLimit(limits.MaxStderrBytes, defaultMaxRemoteStderrBytes))
	if err := r.RunStream(ctx, serverID, command, stdin, &stdout, &stderr); err != nil {
		return nil, remoteCommandError(err, stdout.String(), stderr.String())
	}
	if err := stdout.Err("stdout"); err != nil {
		return nil, err
	}
	if err := stderr.Err("stderr"); err != nil {
		return nil, err
	}
	return parseRemoteJSONLimited(stdout.String(), limits.MaxDecodedBytes)
}

func (r *SSHRuntime) RunCompressedJSON(ctx context.Context, serverID string, command string, stdin io.Reader, encoding string) (map[string]any, error) {
	return r.RunCompressedJSONLimited(ctx, serverID, command, stdin, encoding, OutputLimits{})
}

func (r *SSHRuntime) RunCompressedJSONLimited(ctx context.Context, serverID string, command string, stdin io.Reader, encoding string, limits OutputLimits) (map[string]any, error) {
	stdout := newLimitedBytesWriter(effectiveLimit(limits.MaxStdoutBytes, defaultMaxRemoteStdoutBytes))
	stderr := newLimitedStringWriter(effectiveLimit(limits.MaxStderrBytes, defaultMaxRemoteStderrBytes))
	if err := r.RunStream(ctx, serverID, command, stdin, &stdout, &stderr); err != nil {
		return nil, remoteCommandError(err, "", stderr.String())
	}
	if err := stdout.Err("stdout"); err != nil {
		return nil, err
	}
	if err := stderr.Err("stderr"); err != nil {
		return nil, err
	}
	return parseRemoteCompressedJSONLimited(stdout.Bytes(), encoding, limits.MaxDecodedBytes)
}

func parseRemoteJSON(stdout string) (map[string]any, error) {
	return parseRemoteJSONLimited(stdout, 0)
}

func parseRemoteJSONLimited(stdout string, maxDecodedBytes int64) (map[string]any, error) {
	if err := enforceStringLimit("decoded JSON", stdout, effectiveLimit(maxDecodedBytes, defaultMaxRemoteDecodedBytes)); err != nil {
		return nil, err
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(stdout), &payload); err != nil {
		return nil, fmt.Errorf("remote command did not return a JSON object: %w", err)
	}
	return payload, nil
}

func parseRemoteCompressedJSON(stdout []byte, encoding string) (map[string]any, error) {
	return parseRemoteCompressedJSONLimited(stdout, encoding, 0)
}

func parseRemoteCompressedJSONLimited(stdout []byte, encoding string, maxDecodedBytes int64) (map[string]any, error) {
	normalized := strings.ToLower(strings.TrimSpace(encoding))
	if normalized == "" || normalized == "auto" {
		normalized = detectCompressedJSONEncoding(stdout)
	}
	limit := effectiveLimit(maxDecodedBytes, defaultMaxRemoteDecodedBytes)
	switch normalized {
	case "zstd":
		reader, err := zstd.NewReader(bytes.NewReader(stdout))
		if err != nil {
			return nil, fmt.Errorf("remote command did not return zstd-compressed JSON: %w", err)
		}
		defer reader.Close()
		return decodeLimitedRemoteJSON(reader, limit, "zstd-compressed JSON")
	case "gzip":
		reader, err := gzip.NewReader(bytes.NewReader(stdout))
		if err != nil {
			return nil, fmt.Errorf("remote command did not return gzip-compressed JSON: %w", err)
		}
		defer reader.Close()
		return decodeLimitedRemoteJSON(reader, limit, "gzip-compressed JSON")
	default:
		return nil, fmt.Errorf("unsupported compressed JSON encoding %q", encoding)
	}
}

const (
	defaultMaxRemoteStdoutBytes  int64 = 8 << 20
	defaultMaxRemoteStderrBytes  int64 = 1 << 20
	defaultMaxRemoteDecodedBytes int64 = 32 << 20
)

func effectiveLimit(value int64, fallback int64) int64 {
	if value > 0 {
		return value
	}
	return fallback
}

func enforceStringLimit(label string, value string, limit int64) error {
	if int64(len([]byte(value))) > limit {
		return fmt.Errorf("remote command %s exceeded %d bytes", label, limit)
	}
	return nil
}

func decodeLimitedRemoteJSON(reader io.Reader, limit int64, label string) (map[string]any, error) {
	data, err := readAllLimited(reader, limit)
	if err != nil {
		return nil, err
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, fmt.Errorf("remote command did not return a %s object: %w", label, err)
	}
	return payload, nil
}

func readAllLimited(reader io.Reader, limit int64) ([]byte, error) {
	var buffer bytes.Buffer
	limited := io.LimitReader(reader, limit+1)
	if _, err := buffer.ReadFrom(limited); err != nil {
		return nil, err
	}
	if int64(buffer.Len()) > limit {
		return nil, fmt.Errorf("remote command decoded JSON exceeded %d bytes", limit)
	}
	return buffer.Bytes(), nil
}

type limitedStringWriter struct {
	builder strings.Builder
	limit   int64
	excess  bool
}

func newLimitedStringWriter(limit int64) limitedStringWriter {
	return limitedStringWriter{limit: limit}
}

func (w *limitedStringWriter) Write(data []byte) (int, error) {
	remaining := w.limit - int64(w.builder.Len())
	if remaining <= 0 {
		w.excess = true
		return 0, fmt.Errorf("remote command output exceeded %d bytes", w.limit)
	}
	if int64(len(data)) > remaining {
		w.builder.Write(data[:remaining])
		w.excess = true
		return int(remaining), fmt.Errorf("remote command output exceeded %d bytes", w.limit)
	}
	return w.builder.Write(data)
}

func (w *limitedStringWriter) String() string {
	return w.builder.String()
}

func (w *limitedStringWriter) Err(label string) error {
	if w.excess {
		return fmt.Errorf("remote command %s exceeded %d bytes", label, w.limit)
	}
	return nil
}

type limitedBytesWriter struct {
	buffer bytes.Buffer
	limit  int64
	excess bool
}

func newLimitedBytesWriter(limit int64) limitedBytesWriter {
	return limitedBytesWriter{limit: limit}
}

func (w *limitedBytesWriter) Write(data []byte) (int, error) {
	remaining := w.limit - int64(w.buffer.Len())
	if remaining <= 0 {
		w.excess = true
		return 0, fmt.Errorf("remote command output exceeded %d bytes", w.limit)
	}
	if int64(len(data)) > remaining {
		w.buffer.Write(data[:remaining])
		w.excess = true
		return int(remaining), fmt.Errorf("remote command output exceeded %d bytes", w.limit)
	}
	return w.buffer.Write(data)
}

func (w *limitedBytesWriter) Bytes() []byte {
	return w.buffer.Bytes()
}

func (w *limitedBytesWriter) Err(label string) error {
	if w.excess {
		return fmt.Errorf("remote command %s exceeded %d bytes", label, w.limit)
	}
	return nil
}

func detectCompressedJSONEncoding(stdout []byte) string {
	if len(stdout) >= 4 && stdout[0] == 0x28 && stdout[1] == 0xb5 && stdout[2] == 0x2f && stdout[3] == 0xfd {
		return "zstd"
	}
	if len(stdout) >= 2 && stdout[0] == 0x1f && stdout[1] == 0x8b {
		return "gzip"
	}
	return ""
}

func remoteCommandError(err error, stdout string, stderr string) error {
	detail := strings.TrimSpace(stderr)
	if detail == "" {
		detail = strings.TrimSpace(stdout)
	}
	if detail == "" {
		return err
	}
	detail = SanitizeRemoteCommandDetail(detail)
	const maxDetailLength = 2000
	if len(detail) > maxDetailLength {
		detail = detail[:maxDetailLength] + "..."
	}
	return fmt.Errorf("%w: %s", err, detail)
}

var (
	powerShellCLIXMLErrorPattern  = regexp.MustCompile(`(?s)<S\s+S="Error">(.*?)</S>`)
	powerShellCLIXMLObjectPattern = regexp.MustCompile(`(?s)<Objs\b.*?</Objs>`)
	powerShellCLIXMLEscapePattern = regexp.MustCompile(`_x([0-9A-Fa-f]{4})_`)
)

func SanitizeRemoteCommandDetail(detail string) string {
	detail = strings.TrimSpace(detail)
	if detail == "" {
		return ""
	}
	if !strings.HasPrefix(detail, "#< CLIXML") && !strings.Contains(detail, "<Objs ") {
		return detail
	}
	matches := powerShellCLIXMLErrorPattern.FindAllStringSubmatch(detail, -1)
	if len(matches) == 0 {
		cleaned := strings.TrimSpace(strings.ReplaceAll(detail, "#< CLIXML", ""))
		cleaned = strings.TrimSpace(powerShellCLIXMLObjectPattern.ReplaceAllString(cleaned, ""))
		cleaned = decodePowerShellCLIXMLText(cleaned)
		if strings.TrimSpace(cleaned) != "" {
			return strings.TrimSpace(cleaned)
		}
		return detail
	}
	var builder strings.Builder
	for _, match := range matches {
		if len(match) < 2 {
			continue
		}
		decoded := decodePowerShellCLIXMLText(match[1])
		if strings.TrimSpace(decoded) == "" {
			continue
		}
		builder.WriteString(decoded)
		if !strings.HasSuffix(decoded, "\n") {
			builder.WriteByte('\n')
		}
	}
	cleaned := strings.TrimSpace(builder.String())
	if cleaned == "" {
		return detail
	}
	return cleaned
}

func decodePowerShellCLIXMLText(value string) string {
	decoded := html.UnescapeString(value)
	decoded = powerShellCLIXMLEscapePattern.ReplaceAllStringFunc(decoded, func(token string) string {
		matches := powerShellCLIXMLEscapePattern.FindStringSubmatch(token)
		if len(matches) != 2 {
			return token
		}
		codepoint, err := strconv.ParseInt(matches[1], 16, 32)
		if err != nil {
			return token
		}
		return string(rune(codepoint))
	})
	decoded = strings.ReplaceAll(decoded, "\r\n", "\n")
	decoded = strings.ReplaceAll(decoded, "\r", "\n")
	return decoded
}

func (r *SSHRuntime) Run(ctx context.Context, serverID string, command string) (string, string, error) {
	r.mu.RLock()
	client := r.clients[serverID]
	locked := r.locked
	provider := r.provider
	r.mu.RUnlock()
	if provider == nil && locked {
		return "", "", fmt.Errorf("server access is locked; open ShellOrchestra on the approved phone and sign in to unlock server connections")
	}
	if client == nil {
		return "", "", ErrNotConnected
	}
	session, err := client.NewSession()
	if err != nil {
		if isConnectionEOF(err) {
			r.disconnectClient(serverID, client)
		}
		return "", "", err
	}
	defer session.Close()
	var stdout strings.Builder
	var stderr strings.Builder
	session.Stdout = &stdout
	session.Stderr = &stderr
	done := make(chan error, 1)
	go func() { done <- session.Run(command) }()
	select {
	case <-ctx.Done():
		_ = session.Signal(ssh.SIGKILL)
		cleanupTimedOutPowerShellRuntimeProcess(client, command)
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			r.disconnectClient(serverID, client)
		}
		return stdout.String(), stderr.String(), ctx.Err()
	case err := <-done:
		if isConnectionEOF(err) {
			r.disconnectClient(serverID, client)
		}
		return stdout.String(), stderr.String(), err
	}
}

// RunStream executes a remote command over the managed SSH connection while
// streaming stdin/stdout instead of buffering the whole payload in memory.
func (r *SSHRuntime) RunStream(ctx context.Context, serverID string, command string, stdin io.Reader, stdout io.Writer, stderr io.Writer) error {
	r.mu.RLock()
	client := r.clients[serverID]
	locked := r.locked
	provider := r.provider
	r.mu.RUnlock()
	if provider == nil && locked {
		return fmt.Errorf("server access is locked; open ShellOrchestra on the approved phone and sign in to unlock server connections")
	}
	if client == nil {
		return ErrNotConnected
	}
	return r.runStreamWithClient(ctx, serverID, client, command, stdin, stdout, stderr, true)
}

// RunStreamServer executes a remote command through the per-server transport
// pool. High-volume operations such as file preview/download can otherwise
// exhaust OpenSSH MaxSessions on the single managed status connection.
func (r *SSHRuntime) RunStreamServer(ctx context.Context, server domain.Server, command string, stdin io.Reader, stdout io.Writer, stderr io.Writer) error {
	r.mu.RLock()
	locked := r.locked
	provider := r.provider
	r.mu.RUnlock()
	if provider == nil && locked {
		return fmt.Errorf("server access is locked; open ShellOrchestra on the approved phone and sign in to unlock server connections")
	}
	if strings.TrimSpace(server.ID) == "" {
		return fmt.Errorf("server id is required for pooled SSH stream")
	}
	return r.terminalPool(server.ID).RunStream(ctx, server, command, stdin, stdout, stderr)
}

func (r *SSHRuntime) DialThroughServer(ctx context.Context, server domain.Server, network string, address string) (net.Conn, error) {
	r.mu.RLock()
	locked := r.locked
	provider := r.provider
	r.mu.RUnlock()
	if provider == nil && locked {
		return nil, fmt.Errorf("server access is locked; sign in with an approved device to unlock server connections")
	}
	if strings.TrimSpace(server.ID) == "" {
		return nil, fmt.Errorf("server id is required for pooled SSH dial")
	}
	return r.terminalPool(server.ID).Dial(ctx, server, network, address)
}

func (r *SSHRuntime) runStreamWithClient(ctx context.Context, serverID string, client *ssh.Client, command string, stdin io.Reader, stdout io.Writer, stderr io.Writer, managed bool) error {
	session, err := client.NewSession()
	if err != nil {
		if managed && isConnectionEOF(err) {
			r.disconnectClient(serverID, client)
		}
		return err
	}
	defer session.Close()
	if stdout != nil {
		session.Stdout = stdout
	}
	if stderr != nil {
		session.Stderr = stderr
	}
	if stdin != nil {
		stdinPipe, err := session.StdinPipe()
		if err != nil {
			return err
		}
		go func() {
			_, _ = io.Copy(stdinPipe, stdin)
			_ = stdinPipe.Close()
		}()
	}
	done := make(chan error, 1)
	go func() { done <- session.Run(command) }()
	select {
	case <-ctx.Done():
		_ = session.Signal(ssh.SIGKILL)
		cleanupTimedOutPowerShellRuntimeProcess(client, command)
		if managed && errors.Is(ctx.Err(), context.DeadlineExceeded) {
			r.disconnectClient(serverID, client)
		}
		return ctx.Err()
	case err := <-done:
		if managed && isConnectionEOF(err) {
			r.disconnectClient(serverID, client)
		}
		return err
	}
}

func cleanupTimedOutPowerShellRuntimeProcess(client *ssh.Client, command string) {
	marker := powerShellRuntimeMarkerFromCommand(command)
	if marker == "" {
		return
	}
	cleanupCtx, cancel := context.WithTimeout(context.Background(), powerShellRuntimeCleanupTimeout)
	defer cancel()
	cleanupPowerShellRuntimeProcesses(cleanupCtx, client, marker, 0)
}

func isConnectionEOF(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, io.EOF) || strings.EqualFold(strings.TrimSpace(err.Error()), "EOF")
}

func (r *SSHRuntime) Shell(ctx context.Context, serverID string, options ShellOptions) error {
	r.mu.RLock()
	client := r.clients[serverID]
	locked := r.locked
	provider := r.provider
	r.mu.RUnlock()
	if provider == nil && locked {
		return fmt.Errorf("server access is locked; sign in with an approved device to unlock server connections")
	}
	if client == nil {
		return ErrNotConnected
	}
	return r.shellWithClient(ctx, serverID, client, options, true)
}

// ShellServer opens an interactive shell for a concrete server definition.
// Interactive terminals use their own transport pool instead of the managed
// command/status connection. Target OpenSSH servers commonly cap session
// channels per TCP connection with MaxSessions; the pool reuses a transport
// while it still accepts channels and opens another one when the target refuses
// a new session channel.
func (r *SSHRuntime) ShellServer(ctx context.Context, server domain.Server, options ShellOptions) error {
	r.mu.RLock()
	locked := r.locked
	provider := r.provider
	r.mu.RUnlock()
	if provider == nil && locked {
		return fmt.Errorf("server access is locked; sign in with an approved device to unlock server connections")
	}
	return r.terminalPool(server.ID).Shell(ctx, server, options)
}

func (r *SSHRuntime) terminalPool(serverID string) *SSHTransportPool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.terminalPools == nil {
		r.terminalPools = map[string]*SSHTransportPool{}
	}
	pool := r.terminalPools[serverID]
	if pool == nil || pool.IsClosed() {
		pool = &SSHTransportPool{runtime: r, serverID: serverID, max: maxTerminalTransportsPerServer}
		r.terminalPools[serverID] = pool
	}
	return pool
}

func (p *SSHTransportPool) Shell(ctx context.Context, server domain.Server, options ShellOptions) error {
	var lastSessionLimitErr error
	for attempt := 0; attempt < p.max+1; attempt++ {
		transport, err := p.acquire(ctx, server, false)
		if err != nil {
			if lastSessionLimitErr != nil {
				return fmt.Errorf("target SSH server refused another terminal channel (%v), and ShellOrchestra could not open another SSH transport: %w", lastSessionLimitErr, err)
			}
			return err
		}
		err = p.runtime.shellWithClient(ctx, server.ID, transport.client, options, false)
		retryOnAnotherTransport := shouldOpenDedicatedShellClient(err)
		p.release(transport, err)
		if !retryOnAnotherTransport {
			return err
		}
		lastSessionLimitErr = err
	}
	if lastSessionLimitErr != nil {
		return fmt.Errorf("target SSH server refused terminal channels on every available SSH transport: %w", lastSessionLimitErr)
	}
	return fmt.Errorf("could not open an SSH transport for this terminal")
}

func (p *SSHTransportPool) RunStream(ctx context.Context, server domain.Server, command string, stdin io.Reader, stdout io.Writer, stderr io.Writer) error {
	var lastRetryableErr error
	for attempt := 0; attempt < p.max+1; attempt++ {
		transport, err := p.acquire(ctx, server, true)
		if err != nil {
			if lastRetryableErr != nil {
				return fmt.Errorf("target SSH stream failed on an existing transport (%v), and ShellOrchestra could not open another SSH transport: %w", lastRetryableErr, err)
			}
			return err
		}
		trackedStdout := newStreamWriteTracker(stdout)
		err = p.runtime.runStreamWithClient(ctx, server.ID, transport.client, command, stdin, trackedStdout, stderr, false)
		retryOnAnotherTransport := shouldOpenDedicatedShellClient(err) || shouldRetryReadOnlyStreamOnAnotherTransport(err, stdin, trackedStdout)
		p.release(transport, err)
		if !retryOnAnotherTransport {
			return err
		}
		lastRetryableErr = err
	}
	if lastRetryableErr != nil {
		return fmt.Errorf("target SSH stream failed on every available SSH transport: %w", lastRetryableErr)
	}
	return fmt.Errorf("could not open an SSH transport for this stream")
}

func (p *SSHTransportPool) Dial(ctx context.Context, server domain.Server, network string, address string) (net.Conn, error) {
	transport, err := p.acquire(ctx, server, true)
	if err != nil {
		return nil, err
	}
	type dialResult struct {
		conn net.Conn
		err  error
	}
	done := make(chan dialResult, 1)
	go func() {
		conn, dialErr := transport.client.Dial(network, address)
		done <- dialResult{conn: conn, err: dialErr}
	}()
	select {
	case <-ctx.Done():
		p.release(transport, ctx.Err())
		return nil, ctx.Err()
	case result := <-done:
		if result.err != nil {
			p.release(transport, result.err)
			return nil, result.err
		}
		return &pooledDialConn{Conn: result.conn, pool: p, transport: transport}, nil
	}
}

type pooledDialConn struct {
	net.Conn
	pool      *SSHTransportPool
	transport *pooledSSHTransport
	once      sync.Once
}

func (c *pooledDialConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() {
		c.pool.release(c.transport, err)
	})
	return err
}

type streamWriteTracker struct {
	writer io.Writer
	mu     sync.Mutex
	wrote  bool
}

func newStreamWriteTracker(writer io.Writer) *streamWriteTracker {
	return &streamWriteTracker{writer: writer}
}

func (w *streamWriteTracker) Write(data []byte) (int, error) {
	if w == nil {
		return len(data), nil
	}
	if len(data) > 0 {
		w.mu.Lock()
		w.wrote = true
		w.mu.Unlock()
	}
	if w.writer == nil {
		return len(data), nil
	}
	n, err := w.writer.Write(data)
	return n, err
}

func (w *streamWriteTracker) Wrote() bool {
	if w == nil {
		return false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.wrote
}

func (p *SSHTransportPool) IsClosed() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.closed
}

func (p *SSHTransportPool) Close() {
	p.mu.Lock()
	p.closed = true
	transports := p.transports
	p.transports = nil
	p.mu.Unlock()
	for _, transport := range transports {
		if transport != nil && transport.client != nil {
			_ = transport.client.Close()
		}
	}
}

func (p *SSHTransportPool) acquire(ctx context.Context, server domain.Server, waitForCapacity bool) (*pooledSSHTransport, error) {
	for {
		p.mu.Lock()
		if p.max <= 0 {
			p.max = maxTerminalTransportsPerServer
		}
		if p.closed {
			p.mu.Unlock()
			return nil, fmt.Errorf("SSH transport pool is closed")
		}
		for _, transport := range p.transports {
			if transport == nil || transport.closed || transport.client == nil {
				continue
			}
			channelLimit := transport.channelLimit
			if channelLimit <= 0 || channelLimit > maxChannelsPerSSHTransport {
				channelLimit = maxChannelsPerSSHTransport
			}
			if transport.active >= channelLimit {
				continue
			}
			transport.active++
			p.mu.Unlock()
			return transport, nil
		}
		live := p.liveTransportCountLocked()
		if live+p.opening < p.max {
			p.opening++
			p.mu.Unlock()

			client, err := p.runtime.dialDedicatedShellClient(ctx, server)

			p.mu.Lock()
			p.opening--
			if err != nil {
				p.mu.Unlock()
				return nil, err
			}
			if p.closed {
				p.mu.Unlock()
				_ = client.Close()
				return nil, fmt.Errorf("SSH transport pool is closed")
			}
			p.nextID++
			transport := &pooledSSHTransport{id: p.nextID, client: client, active: 1}
			p.transports = append(p.transports, transport)
			p.mu.Unlock()
			return transport, nil
		}
		max := p.max
		p.mu.Unlock()
		if !waitForCapacity {
			return nil, fmt.Errorf("this server already uses %d SSH transports; close a terminal window or wait for active file operations to finish before opening another one", max)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}

func (p *SSHTransportPool) release(transport *pooledSSHTransport, err error) {
	if transport == nil {
		return
	}
	shouldClose := isConnectionEOF(err) || transportClosedError(err) || retryableSSHTransportError(err)
	sessionLimit := shouldOpenDedicatedShellClient(err)
	var closeClient *ssh.Client
	p.mu.Lock()
	if sessionLimit {
		acceptedChannels := transport.active - 1
		if acceptedChannels > 0 && (transport.channelLimit == 0 || acceptedChannels < transport.channelLimit) {
			transport.channelLimit = acceptedChannels
		}
		if acceptedChannels <= 0 {
			shouldClose = true
		}
	}
	if transport.active > 0 {
		transport.active--
	}
	if shouldClose && !transport.closed {
		transport.closed = true
		closeClient = transport.client
		p.removeTransportLocked(transport)
	}
	p.mu.Unlock()
	if closeClient != nil {
		_ = closeClient.Close()
	}
}

func (p *SSHTransportPool) liveTransportCountLocked() int {
	count := 0
	for _, transport := range p.transports {
		if transport != nil && !transport.closed && transport.client != nil {
			count++
		}
	}
	return count
}

func (p *SSHTransportPool) removeTransportLocked(target *pooledSSHTransport) {
	if target == nil {
		return
	}
	next := p.transports[:0]
	for _, transport := range p.transports {
		if transport != target {
			next = append(next, transport)
		}
	}
	p.transports = next
}

func (r *SSHRuntime) shellWithClient(ctx context.Context, serverID string, client *ssh.Client, options ShellOptions, managed bool) error {
	session, err := client.NewSession()
	if err != nil {
		if managed && isConnectionEOF(err) {
			r.disconnectClient(serverID, client)
		}
		return err
	}
	defer session.Close()
	term := strings.TrimSpace(options.Term)
	if term == "" {
		term = "xterm-256color"
	}
	env := shellSessionEnvironment(term, options.Env)
	for _, key := range shellSessionEnvironmentKeys(env) {
		// Many OpenSSH servers intentionally reject arbitrary environment
		// variables unless AcceptEnv is configured. RequestPty still sets TERM,
		// and ShellOrchestra-launched app scripts set the same environment in
		// their own wrapper, so rejected env requests must not break an
		// interactive terminal.
		_ = session.Setenv(key, env[key])
	}
	cols := options.Cols
	if cols < 20 {
		cols = 80
	}
	rows := options.Rows
	if rows < 5 {
		rows = 24
	}
	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := session.RequestPty(term, rows, cols, modes); err != nil {
		return err
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		return err
	}
	if options.Stdout != nil {
		session.Stdout = options.Stdout
	}
	if options.Stderr != nil {
		session.Stderr = options.Stderr
	}
	if err := session.Shell(); err != nil {
		return err
	}
	copyDone := make(chan struct{})
	go func() {
		if options.Stdin != nil {
			_, _ = io.Copy(stdin, options.Stdin)
		}
		_ = stdin.Close()
		close(copyDone)
	}()
	waitDone := make(chan error, 1)
	go func() { waitDone <- session.Wait() }()
	resize := options.Resize
	for {
		select {
		case <-ctx.Done():
			_ = session.Signal(ssh.SIGKILL)
			_ = session.Close()
			return ctx.Err()
		case <-copyDone:
			// The local terminal proxy has gone away (for example because the
			// virtual-desktop window was closed and its tmux pane was killed).
			// Closing stdin alone is not enough for PTY programs such as
			// `qm terminal`: they can keep the SSH session alive and continue to
			// hold remote resources. End the remote session explicitly.
			_ = session.Signal(ssh.SIGKILL)
			_ = session.Close()
			return io.EOF
		case size, ok := <-resize:
			if !ok {
				resize = nil
				continue
			}
			nextCols := size.Cols
			if nextCols < 20 {
				nextCols = cols
			}
			nextRows := size.Rows
			if nextRows < 5 {
				nextRows = rows
			}
			if err := session.WindowChange(nextRows, nextCols); err != nil {
				_ = stdin.Close()
				return err
			}
		case err := <-waitDone:
			_ = stdin.Close()
			if managed && isConnectionEOF(err) {
				r.disconnectClient(serverID, client)
			}
			return err
		}
	}
}

func shellSessionEnvironment(term string, explicit map[string]string) map[string]string {
	env := make(map[string]string, len(explicit)+1)
	for key, value := range explicit {
		key = strings.TrimSpace(key)
		if key == "" || strings.Contains(key, "=") {
			continue
		}
		env[key] = value
	}
	if _, ok := env["TERM"]; !ok && strings.TrimSpace(term) != "" {
		env["TERM"] = strings.TrimSpace(term)
	}
	return env
}

func shellSessionEnvironmentKeys(env map[string]string) []string {
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func shouldOpenDedicatedShellClient(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "open failed") ||
		strings.Contains(message, "administratively prohibited") ||
		strings.Contains(message, "connect failed") ||
		(strings.Contains(message, "rejected") && strings.Contains(message, "session"))
}

func transportClosedError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "use of closed network connection") ||
		strings.Contains(message, "connection reset by peer") ||
		strings.Contains(message, "broken pipe") ||
		strings.Contains(message, "connection lost") ||
		strings.Contains(message, "client connection lost")
}

func retryableSSHTransportError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "status code 0") ||
		strings.Contains(message, "unexpected eof") ||
		strings.Contains(message, "connection aborted") ||
		strings.Contains(message, "connection closed")
}

func shouldRetryReadOnlyStreamOnAnotherTransport(err error, stdin io.Reader, stdout *streamWriteTracker) bool {
	if err == nil || stdin != nil {
		return false
	}
	if stdout != nil && stdout.Wrote() {
		return false
	}
	return isConnectionEOF(err) || transportClosedError(err) || retryableSSHTransportError(err)
}

func (r *SSHRuntime) dialDedicatedShellClient(ctx context.Context, server domain.Server) (*ssh.Client, error) {
	r.mu.RLock()
	locked := r.locked
	caSigner := r.caSigner
	classicSigner := r.classicSigner
	provider := r.provider
	allowedSourceAddresses := append([]string(nil), r.allowedSourceAddresses...)
	r.mu.RUnlock()
	if provider == nil && locked {
		return nil, fmt.Errorf("server access is locked; sign in with an approved device to unlock server connections")
	}
	if provider != nil {
		providerLocked, err := provider.Locked(ctx)
		if err != nil {
			return nil, err
		}
		if providerLocked {
			return nil, fmt.Errorf("ShellOrchestra SSH signer is locked in this backend runtime")
		}
	}
	clientSigners, err := r.clientSignersFor(ctx, server, caSigner, classicSigner, provider, allowedSourceAddresses)
	if err != nil {
		return nil, err
	}
	hostKeys, err := parseHostKeys(server.HostKey)
	if err != nil {
		return nil, fmt.Errorf("configured host key is invalid: %w", err)
	}
	config := sshClientConfig(server.Username, []ssh.AuthMethod{ssh.PublicKeys(clientSigners...)}, trustedHostKeyCallback(hostKeys), hostKeyAlgorithmsFor(hostKeys), r.options.ConnectTimeout)
	return r.dialSSH(ctx, server, config)
}

type remoteSigner struct {
	publicKey ssh.PublicKey
	sign      func(data []byte, algorithm string) (*ssh.Signature, error)
}

func NewRemoteSigner(publicKey ssh.PublicKey, sign func(data []byte, algorithm string) (*ssh.Signature, error)) ssh.Signer {
	return remoteSigner{publicKey: publicKey, sign: sign}
}

func (s remoteSigner) PublicKey() ssh.PublicKey { return s.publicKey }

func (s remoteSigner) Sign(rand io.Reader, data []byte) (*ssh.Signature, error) {
	return s.sign(data, "")
}

func (s remoteSigner) SignWithAlgorithm(rand io.Reader, data []byte, algorithm string) (*ssh.Signature, error) {
	return s.sign(data, algorithm)
}

func status(serverID string, state domain.ServerStatusState, telemetry map[string]any, message string) domain.ServerStatus {
	if telemetry == nil {
		telemetry = map[string]any{}
	}
	return domain.ServerStatus{ServerID: serverID, State: state, Telemetry: telemetry, LastError: message, UpdatedAt: time.Now().UTC()}
}
