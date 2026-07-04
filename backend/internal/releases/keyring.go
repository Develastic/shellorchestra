// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package releases

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

const KeyringSchemaV1 = "shellorchestra.release-keyring.v1"

type Keyring struct {
	Schema           string         `json:"schema"`
	Signed           SignedKeyring  `json:"signed"`
	SignedPayloadB64 string         `json:"signed_payload_b64,omitempty"`
	Signature        SignatureBlock `json:"signature"`
}

type SignedKeyring struct {
	Product       string          `json:"product"`
	Version       int             `json:"version"`
	IssuedAt      time.Time       `json:"issued_at"`
	ExpiresAt     time.Time       `json:"expires_at"`
	ReleaseKeys   []ReleaseKey    `json:"release_keys"`
	RevokedKeyIDs []string        `json:"revoked_key_ids,omitempty"`
	Mirrors       []ReleaseMirror `json:"mirrors,omitempty"`
}

type ReleaseKey struct {
	KeyID      string    `json:"key_id"`
	PublicKey  string    `json:"public_key"`
	ValidFrom  time.Time `json:"valid_from"`
	ValidUntil time.Time `json:"valid_until"`
	Channels   []string  `json:"channels,omitempty"`
}

type ReleaseMirror struct {
	Name        string `json:"name"`
	KeyringURL  string `json:"keyring_url,omitempty"`
	ManifestURL string `json:"manifest_url,omitempty"`
}

type KeyringVerification struct {
	Keyring           Keyring
	ReleasePublicKeys []ed25519.PublicKey
	KeyIDs            []string
}

func DecodeKeyring(data []byte) (Keyring, error) {
	var keyring Keyring
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&keyring); err != nil {
		return Keyring{}, fmt.Errorf("decode release keyring: %w", err)
	}
	var trailing struct{}
	if err := decoder.Decode(&trailing); err != nil && !errors.Is(err, io.EOF) {
		return Keyring{}, errors.New("release keyring must contain exactly one JSON object")
	}
	if err := keyring.ValidateStructure(); err != nil {
		return Keyring{}, err
	}
	return keyring, nil
}

func (k Keyring) ValidateStructure() error {
	if k.Schema != KeyringSchemaV1 {
		return fmt.Errorf("unsupported release keyring schema %q", k.Schema)
	}
	if strings.TrimSpace(k.Signed.Product) != "ShellOrchestra" {
		return fmt.Errorf("release keyring product must be ShellOrchestra")
	}
	if k.Signed.Version <= 0 {
		return fmt.Errorf("release keyring version must be positive")
	}
	if k.Signed.IssuedAt.IsZero() {
		return fmt.Errorf("release keyring issued_at is required")
	}
	if k.Signed.ExpiresAt.IsZero() || !k.Signed.ExpiresAt.After(k.Signed.IssuedAt) {
		return fmt.Errorf("release keyring expires_at must be after issued_at")
	}
	if len(k.Signed.ReleaseKeys) == 0 {
		return fmt.Errorf("release keyring release_keys are required")
	}
	seen := map[string]bool{}
	for _, keyID := range k.Signed.RevokedKeyIDs {
		if !safeKeyID(keyID) {
			return fmt.Errorf("release keyring revoked key id %q is invalid", keyID)
		}
	}
	for index, key := range k.Signed.ReleaseKeys {
		if err := key.Validate(index); err != nil {
			return err
		}
		if seen[key.KeyID] {
			return fmt.Errorf("release keyring release key id %q is duplicated", key.KeyID)
		}
		seen[key.KeyID] = true
	}
	for index, mirror := range k.Signed.Mirrors {
		if err := mirror.Validate(index); err != nil {
			return err
		}
	}
	if strings.ToLower(strings.TrimSpace(k.Signature.Algorithm)) != "ed25519" {
		return fmt.Errorf("release keyring signature algorithm must be ed25519")
	}
	if !safeKeyID(k.Signature.KeyID) {
		return fmt.Errorf("release keyring signature key_id is invalid")
	}
	if strings.TrimSpace(k.Signature.Value) == "" {
		return fmt.Errorf("release keyring signature value is required")
	}
	if strings.TrimSpace(k.SignedPayloadB64) != "" {
		payload, err := base64.StdEncoding.DecodeString(strings.TrimSpace(k.SignedPayloadB64))
		if err != nil {
			return fmt.Errorf("release keyring signed_payload_b64 is not valid base64: %w", err)
		}
		canonicalPayload, err := CanonicalKeyringSignedPayload(k.Signed)
		if err != nil {
			return err
		}
		if !bytes.Equal(payload, canonicalPayload) {
			return fmt.Errorf("release keyring signed_payload_b64 does not match signed object")
		}
	}
	return nil
}

func (k ReleaseKey) Validate(index int) error {
	if !safeKeyID(k.KeyID) {
		return fmt.Errorf("release keyring release_keys[%d].key_id is invalid", index)
	}
	if _, err := parseTrustedPublicKey(k.PublicKey); err != nil {
		return fmt.Errorf("release keyring release_keys[%d].public_key is invalid: %w", index, err)
	}
	if k.ValidFrom.IsZero() {
		return fmt.Errorf("release keyring release_keys[%d].valid_from is required", index)
	}
	if k.ValidUntil.IsZero() || !k.ValidUntil.After(k.ValidFrom) {
		return fmt.Errorf("release keyring release_keys[%d].valid_until must be after valid_from", index)
	}
	for _, channel := range k.Channels {
		if !safeToken(channel) {
			return fmt.Errorf("release keyring release_keys[%d].channels contains invalid channel %q", index, channel)
		}
	}
	return nil
}

func (m ReleaseMirror) Validate(index int) error {
	if strings.TrimSpace(m.Name) == "" || len(strings.TrimSpace(m.Name)) > 80 {
		return fmt.Errorf("release keyring mirrors[%d].name is invalid", index)
	}
	if strings.TrimSpace(m.KeyringURL) != "" {
		if err := validateHTTPSURL(m.KeyringURL, fmt.Sprintf("release keyring mirrors[%d].keyring_url", index)); err != nil {
			return err
		}
	}
	if strings.TrimSpace(m.ManifestURL) != "" {
		if err := validateHTTPSURL(m.ManifestURL, fmt.Sprintf("release keyring mirrors[%d].manifest_url", index)); err != nil {
			return err
		}
	}
	return nil
}

func (k Keyring) Verify(rootKeys []ed25519.PublicKey) error {
	if len(rootKeys) == 0 {
		return fmt.Errorf("no trusted release root public keys are configured")
	}
	signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(k.Signature.Value))
	if err != nil {
		return fmt.Errorf("release keyring signature is not valid base64: %w", err)
	}
	payload, err := k.SignedPayload()
	if err != nil {
		return err
	}
	for _, publicKey := range rootKeys {
		if len(publicKey) != ed25519.PublicKeySize {
			continue
		}
		if ed25519.Verify(publicKey, payload, signature) {
			return nil
		}
	}
	return fmt.Errorf("release keyring does not match any trusted root public key")
}

func (k Keyring) SignedPayload() ([]byte, error) {
	if strings.TrimSpace(k.SignedPayloadB64) != "" {
		payload, err := base64.StdEncoding.DecodeString(strings.TrimSpace(k.SignedPayloadB64))
		if err != nil {
			return nil, fmt.Errorf("release keyring signed_payload_b64 is not valid base64: %w", err)
		}
		return payload, nil
	}
	return CanonicalKeyringSignedPayload(k.Signed)
}

func CanonicalKeyringSignedPayload(signed SignedKeyring) ([]byte, error) {
	payload, err := json.Marshal(signed)
	if err != nil {
		return nil, fmt.Errorf("encode release keyring signed payload: %w", err)
	}
	return payload, nil
}

func (k Keyring) ReleasePublicKeys(channel string, keyID string, now time.Time) ([]ed25519.PublicKey, []string, error) {
	now = now.UTC()
	if !now.Before(k.Signed.ExpiresAt) {
		return nil, nil, fmt.Errorf("release keyring version %d expired at %s", k.Signed.Version, k.Signed.ExpiresAt.Format(time.RFC3339))
	}
	revoked := map[string]bool{}
	for _, id := range k.Signed.RevokedKeyIDs {
		revoked[id] = true
	}
	publicKeys := []ed25519.PublicKey{}
	keyIDs := []string{}
	for _, key := range k.Signed.ReleaseKeys {
		if revoked[key.KeyID] {
			continue
		}
		if keyID != "" && key.KeyID != keyID {
			continue
		}
		if now.Before(key.ValidFrom) || !now.Before(key.ValidUntil) {
			continue
		}
		if !releaseKeyAllowsChannel(key, channel) {
			continue
		}
		publicKey, err := parseTrustedPublicKey(key.PublicKey)
		if err != nil {
			return nil, nil, err
		}
		publicKeys = append(publicKeys, publicKey)
		keyIDs = append(keyIDs, key.KeyID)
	}
	if len(publicKeys) == 0 {
		if keyID != "" {
			return nil, nil, fmt.Errorf("release keyring has no active release key %q for channel %q", keyID, channel)
		}
		return nil, nil, fmt.Errorf("release keyring has no active release keys for channel %q", channel)
	}
	return publicKeys, keyIDs, nil
}

func releaseKeyAllowsChannel(key ReleaseKey, channel string) bool {
	channel = strings.TrimSpace(channel)
	if channel == "" {
		return true
	}
	if len(key.Channels) == 0 {
		return true
	}
	for _, allowed := range key.Channels {
		if allowed == channel {
			return true
		}
	}
	return false
}
