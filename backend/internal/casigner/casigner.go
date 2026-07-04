// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package casigner

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"shellorchestra/backend/internal/config"
	"shellorchestra/backend/internal/domain"
	"shellorchestra/backend/internal/httplimits"
	"shellorchestra/backend/internal/internaljson"
	"shellorchestra/backend/internal/internalurl"
	"shellorchestra/backend/internal/runtime"
	"shellorchestra/backend/internal/security"
	"shellorchestra/backend/internal/serviceinfo"
	"shellorchestra/backend/internal/store"
)

const (
	maxCASignerJSONBodyBytes         = 1 << 20
	maxCASignerJSONResponseBodyBytes = 1 << 20
)

type StateResponse struct {
	Locked      bool   `json:"locked"`
	Initialized bool   `json:"initialized"`
	Message     string `json:"message"`
	PublicKey   string `json:"public_key,omitempty"`
	TTL         int    `json:"cert_ttl_minutes"`
}

type Server struct {
	cfg           config.AppConfig
	store         *store.SQLiteStore
	mu            sync.RWMutex
	seed          []byte
	signer        ssh.Signer
	classicSigner ssh.Signer
}

type Client struct {
	baseURL        *url.URL
	internalSecret string
	client         *http.Client
}

type signRequest struct {
	ServerID     string `json:"server_id"`
	Principal    string `json:"principal"`
	PublicKeyB64 string `json:"public_key_b64"`
}

type signResponse struct {
	Certificate string `json:"certificate"`
	ValidBefore string `json:"valid_before"`
}

type signDataRequest struct {
	KeyID         string `json:"key_id"`
	DataB64       string `json:"data_b64"`
	Algorithm     string `json:"algorithm"`
	UseClassic    bool   `json:"use_classic"`
	PublicKeyOnly bool   `json:"public_key_only"`
}

type signDataResponse struct {
	PublicKey string `json:"public_key"`
	Format    string `json:"format,omitempty"`
	BlobB64   string `json:"blob_b64,omitempty"`
}

type unlockShareRequest struct {
	DeviceShareB64 string `json:"device_share_b64"`
}

type unlockLANRequest struct {
	Passphrase string `json:"passphrase"`
}

type encryptDeviceShareRequest struct {
	EnvelopePublicKeySPKIB64 string `json:"envelope_public_key_spki_b64"`
}

type EncryptDeviceShareResponse struct {
	ActiveEpoch             int    `json:"active_epoch"`
	EncryptedDeviceShareB64 string `json:"encrypted_device_share_b64"`
}

type createAuthorityRequest struct {
	Mode       string `json:"mode"`
	Passphrase string `json:"passphrase"`
	PrivateKey string `json:"private_key"`
	PublicKey  string `json:"public_key"`
	Label      string `json:"label"`
}

type CreateAuthorityResponse struct {
	Label            string `json:"label"`
	PublicKey        string `json:"public_key"`
	ClassicPublicKey string `json:"classic_public_key,omitempty"`
	ActiveEpoch      int    `json:"active_epoch"`
	DeviceShareB64   string `json:"device_share_b64,omitempty"`
}

func NewServer(cfg config.AppConfig, db *store.SQLiteStore) *Server {
	return &Server{cfg: cfg, store: db}
}

func NewClient(rawURL string, internalSecret string) (*Client, error) {
	parsed, err := internalurl.ParseServiceURL(rawURL, "internal.signer_url")
	if err != nil {
		return nil, err
	}
	secret := strings.TrimSpace(internalSecret)
	if secret == "" {
		return nil, fmt.Errorf("internal.shared_secret is required for ca-signer")
	}
	return &Client{baseURL: parsed, internalSecret: secret, client: &http.Client{Timeout: 15 * time.Second}}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/service/status", serviceinfo.Handler(s.cfg, "ca-signer", s.serviceStatusDetails))
	mux.HandleFunc("/internal/ca/healthz", s.health)
	mux.HandleFunc("/internal/ca/state", s.state)
	mux.HandleFunc("/internal/ca/lock", s.lock)
	mux.HandleFunc("/internal/ca/unlock-shares", s.unlockShares)
	mux.HandleFunc("/internal/ca/unlock-lan", s.unlockLAN)
	mux.HandleFunc("/internal/ca/create-authority", s.createAuthority)
	mux.HandleFunc("/internal/ca/encrypt-device-share", s.encryptDeviceShare)
	mux.HandleFunc("/internal/ca/sign", s.sign)
	mux.HandleFunc("/internal/ca/sign-data", s.signData)
	return mux
}

func (s *Server) serviceStatusDetails(ctx context.Context) map[string]any {
	state := s.stateResponse(ctx)
	return map[string]any{
		"locked":           state.Locked,
		"initialized":      state.Initialized,
		"cert_ttl_minutes": state.TTL,
	}
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "ca-signer"})
}

func (s *Server) state(w http.ResponseWriter, r *http.Request) {
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	writeJSON(w, http.StatusOK, s.stateResponse(r.Context()))
}

func (s *Server) lock(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	s.mu.Lock()
	s.seed = nil
	s.signer = nil
	s.classicSigner = nil
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, s.stateResponse(r.Context()))
}

func (s *Server) unlockShares(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body unlockShareRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	authority, err := s.store.GetAuthority(r.Context())
	if err != nil {
		writeError(w, http.StatusConflict, "ShellOrchestra key authority is not initialized.")
		return
	}
	if authority.AuthMode == store.AuthModeLANTOTP {
		writeError(w, http.StatusBadRequest, "This installation uses LAN-only one-time-code sign-in. Use LAN unlock instead.")
		return
	}
	seed, err := security.SeedFromShares(authority.BackendShareB64, body.DeviceShareB64)
	if err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	publicKey, err := security.PublicKeyOpenSSHFromSeed(seed)
	if err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	if publicKey != authority.PublicKeyOpenSSH {
		writeError(w, http.StatusForbidden, "Device share does not reconstruct the configured ShellOrchestra key.")
		return
	}
	if err := s.setAuthoritySeed(seed); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, s.stateResponse(r.Context()))
}

func (s *Server) unlockLAN(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body unlockLANRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	authority, err := s.store.GetAuthority(r.Context())
	if err != nil || authority.AuthMode != store.AuthModeLANTOTP {
		writeError(w, http.StatusConflict, "LAN-only key authority is not initialized.")
		return
	}
	seed, err := security.DecryptSeedWithPassphrase(security.EncryptedSeed{
		CiphertextB64: authority.EncryptedSeedB64,
		SaltB64:       authority.KDFSaltB64,
		NonceB64:      authority.NonceB64,
		KDFName:       authority.KDFName,
		KDFParamsJSON: authority.KDFParamsJSON,
	}, body.Passphrase)
	if err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	publicKey, err := security.PublicKeyOpenSSHFromSeed(seed)
	if err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	if publicKey != authority.PublicKeyOpenSSH {
		writeError(w, http.StatusForbidden, "Admin passphrase does not unlock the configured ShellOrchestra key.")
		return
	}
	if err := s.setAuthoritySeed(seed); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, s.stateResponse(r.Context()))
}

func (s *Server) createAuthority(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body createAuthorityRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	var material security.AuthorityMaterial
	var err error
	if strings.TrimSpace(body.PrivateKey) == "" {
		material, _, _, err = security.GenerateAuthorityMaterial()
	} else {
		material, err = security.MaterialFromOpenSSHKeyPair([]byte(body.PrivateKey), body.PublicKey)
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	label := authorityLabel(body.Label, strings.TrimSpace(body.PrivateKey) != "")
	mode := store.AuthMode(strings.TrimSpace(body.Mode))
	switch mode {
	case store.AuthModePasskey:
		authority, backendShare, deviceShare, err := authorityFromPasskeyMaterial(material)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		authority.Label = label
		authority = nextAuthority(r.Context(), s.store, authority)
		if err := s.store.SaveAuthority(r.Context(), authority); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if err := s.setAuthoritySeed(material.Seed); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		_ = backendShare
		writeJSON(w, http.StatusOK, CreateAuthorityResponse{Label: authority.Label, PublicKey: material.PublicKeyOpenSSH, ClassicPublicKey: material.ClassicPublicKeyOpenSSH, ActiveEpoch: authority.ActiveEpoch, DeviceShareB64: security.B64(deviceShare)})
	case store.AuthModeLANTOTP:
		if strings.TrimSpace(body.Passphrase) == "" {
			writeError(w, http.StatusBadRequest, "Admin passphrase is required to protect LAN-only server access keys.")
			return
		}
		encrypted, err := security.EncryptSeedWithPassphrase(material.Seed, body.Passphrase)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		authority := nextAuthority(r.Context(), s.store, store.Authority{AuthMode: store.AuthModeLANTOTP, Label: label, PublicKeyOpenSSH: material.PublicKeyOpenSSH, ClassicPublicKeyOpenSSH: material.ClassicPublicKeyOpenSSH, EncryptedSeedB64: encrypted.CiphertextB64, KDFSaltB64: encrypted.SaltB64, NonceB64: encrypted.NonceB64, KDFName: encrypted.KDFName, KDFParamsJSON: encrypted.KDFParamsJSON})
		if err := s.store.SaveAuthority(r.Context(), authority); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if err := s.setAuthoritySeed(material.Seed); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, CreateAuthorityResponse{Label: authority.Label, PublicKey: material.PublicKeyOpenSSH, ClassicPublicKey: material.ClassicPublicKeyOpenSSH, ActiveEpoch: authority.ActiveEpoch})
	default:
		writeError(w, http.StatusBadRequest, "Unsupported key authority mode.")
	}
}

func (s *Server) encryptDeviceShare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body encryptDeviceShareRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	authority, err := s.store.GetAuthority(r.Context())
	if err != nil || authority.AuthMode != store.AuthModePasskey {
		writeError(w, http.StatusConflict, "Passkey key authority is not initialized.")
		return
	}
	s.mu.RLock()
	seed := append([]byte(nil), s.seed...)
	s.mu.RUnlock()
	if len(seed) == 0 {
		writeError(w, http.StatusLocked, errLocked.Error())
		return
	}
	deviceShare, err := deviceShareB64ForSeed(seed, authority.BackendShareB64)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	encrypted, err := encryptDeviceShareForEnvelope(deviceShare, body.EnvelopePublicKeySPKIB64)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, EncryptDeviceShareResponse{
		ActiveEpoch:             authority.ActiveEpoch,
		EncryptedDeviceShareB64: encrypted,
	})
}

func authorityLabel(label string, imported bool) string {
	trimmed := strings.TrimSpace(label)
	if trimmed != "" {
		return trimmed
	}
	if imported {
		return "Imported SSH CA"
	}
	return "ShellOrchestra generated SSH CA"
}

func authorityFromPasskeyMaterial(material security.AuthorityMaterial) (store.Authority, []byte, []byte, error) {
	backendShare := make([]byte, security.ShareSize)
	if _, err := rand.Read(backendShare); err != nil {
		return store.Authority{}, nil, nil, err
	}
	deviceShare, err := security.DeriveDeviceShare(material.Seed, backendShare)
	if err != nil {
		return store.Authority{}, nil, nil, err
	}
	return store.Authority{AuthMode: store.AuthModePasskey, PublicKeyOpenSSH: material.PublicKeyOpenSSH, ClassicPublicKeyOpenSSH: material.ClassicPublicKeyOpenSSH, BackendShareB64: security.B64(backendShare), ActiveEpoch: 1}, backendShare, deviceShare, nil
}

func nextAuthority(ctx context.Context, db *store.SQLiteStore, authority store.Authority) store.Authority {
	activeEpoch := 1
	if current, err := db.GetAuthority(ctx); err == nil && current.ActiveEpoch > 0 {
		activeEpoch = current.ActiveEpoch + 1
	}
	authority.ActiveEpoch = activeEpoch
	return authority
}

func (s *Server) sign(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body signRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	principal := strings.TrimSpace(body.Principal)
	if principal == "" {
		writeError(w, http.StatusBadRequest, "SSH certificate principal is required.")
		return
	}
	keyBytes, err := base64.StdEncoding.DecodeString(strings.TrimSpace(body.PublicKeyB64))
	if err != nil {
		writeError(w, http.StatusBadRequest, "SSH public key is not valid base64.")
		return
	}
	publicKey, err := ssh.ParsePublicKey(keyBytes)
	if err != nil {
		writeError(w, http.StatusBadRequest, "SSH public key is invalid.")
		return
	}
	cert, err := s.signCertificate(r.Context(), body.ServerID, principal, publicKey)
	if err != nil {
		if errors.Is(err, errLocked) {
			writeError(w, http.StatusLocked, "ShellOrchestra SSH CA is locked.")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, signResponse{Certificate: string(bytes.TrimSpace(ssh.MarshalAuthorizedKey(cert))), ValidBefore: time.Unix(int64(cert.ValidBefore), 0).UTC().Format(time.RFC3339)})
}

func (s *Server) signData(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body signDataRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	signer, err := s.signerForDataRequest(r.Context(), body)
	if err != nil {
		if errors.Is(err, errLocked) {
			writeError(w, http.StatusLocked, "ShellOrchestra SSH signer is locked.")
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	publicKey := string(bytes.TrimSpace(ssh.MarshalAuthorizedKey(signer.PublicKey())))
	if body.PublicKeyOnly {
		writeJSON(w, http.StatusOK, signDataResponse{PublicKey: publicKey})
		return
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(body.DataB64))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Data to sign is not valid base64.")
		return
	}
	signature, err := signWithOptionalAlgorithm(signer, data, strings.TrimSpace(body.Algorithm))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, signDataResponse{PublicKey: publicKey, Format: signature.Format, BlobB64: base64.StdEncoding.EncodeToString(signature.Blob)})
}

func (s *Server) signerForDataRequest(ctx context.Context, body signDataRequest) (ssh.Signer, error) {
	s.mu.RLock()
	caUnlocked := s.signer != nil
	classicSigner := s.classicSigner
	s.mu.RUnlock()
	if !caUnlocked {
		return nil, errLocked
	}
	if body.UseClassic {
		if classicSigner == nil {
			return nil, fmt.Errorf("classic fallback key is not unlocked")
		}
		return classicSigner, nil
	}
	key, err := s.store.GetSSHUserKey(ctx, body.KeyID)
	if err != nil {
		return nil, fmt.Errorf("SSH key was not found")
	}
	signer, err := ssh.ParsePrivateKey([]byte(key.PrivateKeyOpenSSH))
	if err != nil {
		return nil, fmt.Errorf("stored SSH key is invalid: %w", err)
	}
	return signer, nil
}

func signWithOptionalAlgorithm(signer ssh.Signer, data []byte, algorithm string) (*ssh.Signature, error) {
	if algorithm != "" {
		if algorithmSigner, ok := signer.(ssh.AlgorithmSigner); ok {
			return algorithmSigner.SignWithAlgorithm(rand.Reader, data, algorithm)
		}
	}
	return signer.Sign(rand.Reader, data)
}

var errLocked = errors.New("ca signer is locked")

func (s *Server) signCertificate(ctx context.Context, serverID string, principal string, userKey ssh.PublicKey) (*ssh.Certificate, error) {
	s.mu.RLock()
	signer := s.signer
	s.mu.RUnlock()
	if signer == nil {
		return nil, errLocked
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	criticalOptions := map[string]string{}
	settings, err := s.store.GetSSHSecuritySettings(ctx)
	if err != nil {
		return nil, fmt.Errorf("load SSH security settings: %w", err)
	}
	ttl := time.Duration(settings.CertTTLMinutes) * time.Minute
	if ttl <= 0 {
		ttl = time.Duration(s.cfg.SSHCA.CertTTLMinutes) * time.Minute
	}
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	if len(settings.AllowedSourceAddresses) > 0 {
		criticalOptions["source-address"] = strings.Join(settings.AllowedSourceAddresses, ",")
	}
	cert := &ssh.Certificate{
		Nonce:           randomNonce(32),
		Key:             userKey,
		Serial:          serial,
		CertType:        ssh.UserCert,
		KeyId:           "shellorchestra:" + strings.TrimSpace(serverID),
		ValidPrincipals: []string{principal},
		ValidAfter:      uint64(now.Add(-30 * time.Second).Unix()),
		ValidBefore:     uint64(now.Add(ttl).Unix()),
		Permissions: ssh.Permissions{CriticalOptions: criticalOptions, Extensions: map[string]string{
			"permit-pty":              "",
			"permit-user-rc":          "",
			"permit-port-forwarding":  "",
			"permit-agent-forwarding": "",
		}},
	}
	if err := cert.SignCert(rand.Reader, signer); err != nil {
		return nil, fmt.Errorf("sign SSH user certificate: %w", err)
	}
	return cert, nil
}

func (s *Server) stateResponse(ctx context.Context) StateResponse {
	s.mu.RLock()
	locked := s.signer == nil
	s.mu.RUnlock()
	publicKey := ""
	if authority, err := s.store.GetAuthority(ctx); err == nil {
		publicKey = authority.PublicKeyOpenSSH
	}
	message := "SERVER ACCESS IS UNLOCKED. ShellOrchestra can issue short-lived SSH certificates."
	if publicKey == "" {
		message = "SERVER ACCESS KEYS ARE NOT INITIALIZED. Open Keys from a desktop browser to set up server access."
	} else if locked {
		message = "SERVER ACCESS IS LOCKED. Sign in with the configured security method to unlock SSH certificates."
	}
	ttl := s.cfg.SSHCA.CertTTLMinutes
	if settings, err := s.store.GetSSHSecuritySettings(ctx); err == nil && settings.CertTTLMinutes > 0 {
		ttl = settings.CertTTLMinutes
	}
	return StateResponse{Locked: locked, Initialized: publicKey != "", Message: message, PublicKey: publicKey, TTL: ttl}
}

func (s *Server) setSigner(signer ssh.Signer) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.signer = signer
}

func (s *Server) setAuthoritySeed(seed []byte) error {
	signer, err := security.SignerFromSeed(seed)
	if err != nil {
		return err
	}
	classicSeed, err := security.ClassicFallbackSeedFromAuthoritySeed(seed)
	if err != nil {
		return err
	}
	classicSigner, err := security.SignerFromSeed(classicSeed)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seed = append([]byte(nil), seed...)
	s.signer = signer
	s.classicSigner = classicSigner
	return nil
}

func deviceShareB64ForSeed(seed []byte, backendShareB64 string) (string, error) {
	backendShare, err := base64.StdEncoding.DecodeString(backendShareB64)
	if err != nil {
		return "", fmt.Errorf("backend share is invalid base64: %w", err)
	}
	deviceShare, err := security.DeriveDeviceShare(seed, backendShare)
	if err != nil {
		return "", err
	}
	return security.B64(deviceShare), nil
}

func encryptDeviceShareForEnvelope(deviceShareB64 string, envelopePublicKeySPKIB64 string) (string, error) {
	der, err := base64.StdEncoding.DecodeString(strings.TrimSpace(envelopePublicKeySPKIB64))
	if err != nil {
		return "", fmt.Errorf("envelope public key is invalid base64: %w", err)
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return "", fmt.Errorf("envelope public key is not a DER SPKI key: %w", err)
	}
	publicKey, ok := parsed.(*rsa.PublicKey)
	if !ok {
		return "", fmt.Errorf("envelope public key must be an RSA-OAEP public key")
	}
	ciphertext, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, publicKey, []byte(deviceShareB64), nil)
	if err != nil {
		return "", fmt.Errorf("encrypt device share for envelope: %w", err)
	}
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

func (s *Server) validInternalRequest(r *http.Request) bool {
	expected := strings.TrimSpace(s.cfg.Internal.SharedSecret)
	provided := strings.TrimSpace(r.Header.Get("X-ShellOrchestra-Internal-Secret"))
	if expected == "" || provided == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func (c *Client) Locked(ctx context.Context) (bool, error) {
	state, err := c.State(ctx)
	if err != nil {
		return true, err
	}
	return state.Locked, nil
}

func (c *Client) State(ctx context.Context) (StateResponse, error) {
	var state StateResponse
	if err := c.do(ctx, http.MethodGet, "/internal/ca/state", nil, &state); err != nil {
		return StateResponse{Locked: true}, err
	}
	return state, nil
}

func (c *Client) Lock(ctx context.Context) (StateResponse, error) {
	var state StateResponse
	err := c.do(ctx, http.MethodPost, "/internal/ca/lock", map[string]any{}, &state)
	return state, err
}

func (c *Client) UnlockWithDeviceShare(ctx context.Context, deviceShareB64 string) (StateResponse, error) {
	var state StateResponse
	err := c.do(ctx, http.MethodPost, "/internal/ca/unlock-shares", unlockShareRequest{DeviceShareB64: deviceShareB64}, &state)
	return state, err
}

func (c *Client) UnlockLAN(ctx context.Context, passphrase string) (StateResponse, error) {
	var state StateResponse
	err := c.do(ctx, http.MethodPost, "/internal/ca/unlock-lan", unlockLANRequest{Passphrase: passphrase}, &state)
	return state, err
}

func (c *Client) CreateAuthority(ctx context.Context, mode store.AuthMode, passphrase string, privateKey string, publicKey string, label string) (CreateAuthorityResponse, error) {
	var response CreateAuthorityResponse
	err := c.do(ctx, http.MethodPost, "/internal/ca/create-authority", createAuthorityRequest{Mode: string(mode), Passphrase: passphrase, PrivateKey: privateKey, PublicKey: publicKey, Label: label}, &response)
	return response, err
}

func (c *Client) EncryptCurrentDeviceShare(ctx context.Context, envelopePublicKeySPKIB64 string) (EncryptDeviceShareResponse, error) {
	var response EncryptDeviceShareResponse
	err := c.do(ctx, http.MethodPost, "/internal/ca/encrypt-device-share", encryptDeviceShareRequest{EnvelopePublicKeySPKIB64: envelopePublicKeySPKIB64}, &response)
	return response, err
}

func (c *Client) SignUserCertificate(ctx context.Context, server domain.Server, userKey ssh.PublicKey) (*ssh.Certificate, error) {
	var response signResponse
	err := c.do(ctx, http.MethodPost, "/internal/ca/sign", signRequest{ServerID: server.ID, Principal: server.Username, PublicKeyB64: base64.StdEncoding.EncodeToString(userKey.Marshal())}, &response)
	if err != nil {
		return nil, err
	}
	parsed, _, _, _, err := ssh.ParseAuthorizedKey([]byte(response.Certificate))
	if err != nil {
		return nil, fmt.Errorf("CA signer returned an invalid SSH certificate: %w", err)
	}
	cert, ok := parsed.(*ssh.Certificate)
	if !ok || cert.CertType != ssh.UserCert {
		return nil, fmt.Errorf("CA signer returned a non-user SSH certificate")
	}
	return cert, nil
}

func (c *Client) ClassicSigner(ctx context.Context) (ssh.Signer, error) {
	return c.remoteDataSigner(ctx, signDataRequest{UseClassic: true, PublicKeyOnly: true})
}

func (c *Client) CustomKeySigner(ctx context.Context, keyID string) (ssh.Signer, error) {
	return c.remoteDataSigner(ctx, signDataRequest{KeyID: strings.TrimSpace(keyID), PublicKeyOnly: true})
}

func (c *Client) remoteDataSigner(ctx context.Context, template signDataRequest) (ssh.Signer, error) {
	var response signDataResponse
	if err := c.do(ctx, http.MethodPost, "/internal/ca/sign-data", template, &response); err != nil {
		return nil, err
	}
	publicKey, _, _, _, err := ssh.ParseAuthorizedKey([]byte(response.PublicKey))
	if err != nil {
		return nil, fmt.Errorf("CA signer returned an invalid public key: %w", err)
	}
	return runtime.NewRemoteSigner(publicKey, func(data []byte, algorithm string) (*ssh.Signature, error) {
		request := template
		request.PublicKeyOnly = false
		request.DataB64 = base64.StdEncoding.EncodeToString(data)
		request.Algorithm = algorithm
		var signed signDataResponse
		if err := c.do(ctx, http.MethodPost, "/internal/ca/sign-data", request, &signed); err != nil {
			return nil, err
		}
		blob, err := base64.StdEncoding.DecodeString(signed.BlobB64)
		if err != nil {
			return nil, fmt.Errorf("CA signer returned an invalid SSH signature: %w", err)
		}
		return &ssh.Signature{Format: signed.Format, Blob: blob}, nil
	}), nil
}

func (c *Client) do(ctx context.Context, method string, path string, payload any, out any) error {
	requestURL := c.baseURL.ResolveReference(&url.URL{Path: path})
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, requestURL.String(), body)
	if err != nil {
		return err
	}
	req.Header.Set("X-ShellOrchestra-Internal-Secret", c.internalSecret)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var payload struct {
			Error string `json:"error"`
		}
		internaljson.DecodeBestEffort(resp.Body, 64<<10, &payload)
		if payload.Error == "" {
			payload.Error = resp.Status
		}
		return fmt.Errorf("%s", payload.Error)
	}
	if out == nil || resp.StatusCode == http.StatusNoContent {
		return nil
	}
	return internaljson.DecodeStrictResponse(resp.Body, maxCASignerJSONResponseBodyBytes, out, "ca-signer response")
}

func ListenAndServe(ctx context.Context, cfg config.AppConfig, db *store.SQLiteStore) error {
	server := &http.Server{Addr: cfg.App.ListenAddr, Handler: NewServer(cfg, db).Handler(), ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: httplimits.MaxHeaderBytes}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
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

func decodeJSON(w http.ResponseWriter, r *http.Request, out any) bool {
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxCASignerJSONBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON request body.")
		return false
	}
	var trailing struct{}
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeError(w, http.StatusBadRequest, "Invalid JSON request body.")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func methodNotAllowed(w http.ResponseWriter) {
	writeError(w, http.StatusMethodNotAllowed, "Method not allowed.")
}
