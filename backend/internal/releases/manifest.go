// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package releases

import (
	"bytes"
	"crypto/ed25519"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const SchemaV1 = "shellorchestra.release-manifest.v1"

type Manifest struct {
	Schema           string         `json:"schema"`
	Signed           SignedManifest `json:"signed"`
	SignedPayloadB64 string         `json:"signed_payload_b64,omitempty"`
	Signature        SignatureBlock `json:"signature"`
}

type SignedManifest struct {
	Product          string              `json:"product"`
	Channel          string              `json:"channel"`
	Latest           string              `json:"latest"`
	ReleasedAt       time.Time           `json:"released_at"`
	MinimumSupported string              `json:"minimum_supported"`
	Critical         bool                `json:"critical"`
	ReleaseNotesURL  string              `json:"release_notes_url"`
	Artifacts        map[string]Artifact `json:"artifacts"`
}

type Artifact struct {
	URL       string `json:"url"`
	SHA256    string `json:"sha256"`
	Signature string `json:"signature"`
}

type SignatureBlock struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"key_id"`
	Value     string `json:"value"`
}

type Version struct {
	Major int
	Minor int
	Build int
}

var (
	versionPattern  = regexp.MustCompile(`^([0-9]+)\.([0-9]+)\.([0-9]+)$`)
	errNoTrustedKey = errors.New("release manifest does not match any trusted public key")
)

func DecodeManifest(data []byte) (Manifest, error) {
	var manifest Manifest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("decode release manifest: %w", err)
	}
	var trailing struct{}
	if err := decoder.Decode(&trailing); err != nil && !errors.Is(err, io.EOF) {
		return Manifest{}, errors.New("release manifest must contain exactly one JSON object")
	}
	if err := manifest.ValidateStructure(); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func (m Manifest) ValidateStructure() error {
	if m.Schema != SchemaV1 {
		return fmt.Errorf("unsupported release manifest schema %q", m.Schema)
	}
	if strings.TrimSpace(m.Signed.Product) != "ShellOrchestra" {
		return fmt.Errorf("release manifest product must be ShellOrchestra")
	}
	if !safeToken(m.Signed.Channel) {
		return fmt.Errorf("release manifest channel is invalid")
	}
	if _, err := ParseVersion(m.Signed.Latest); err != nil {
		return fmt.Errorf("release manifest latest version is invalid: %w", err)
	}
	if strings.TrimSpace(m.Signed.MinimumSupported) != "" {
		if _, err := ParseVersion(m.Signed.MinimumSupported); err != nil {
			return fmt.Errorf("release manifest minimum_supported version is invalid: %w", err)
		}
		comparison, err := CompareVersions(m.Signed.MinimumSupported, m.Signed.Latest)
		if err != nil {
			return fmt.Errorf("release manifest minimum_supported version cannot be compared: %w", err)
		}
		if comparison > 0 {
			return fmt.Errorf("release manifest minimum_supported version must not be newer than latest")
		}
	}
	if m.Signed.ReleasedAt.IsZero() {
		return fmt.Errorf("release manifest released_at is required")
	}
	if err := validateHTTPSURL(m.Signed.ReleaseNotesURL, "release_notes_url"); err != nil {
		return err
	}
	if len(m.Signed.Artifacts) == 0 {
		return fmt.Errorf("release manifest artifacts are required")
	}
	for name, artifact := range m.Signed.Artifacts {
		if !safeArtifactName(name) {
			return fmt.Errorf("release manifest artifact name %q is invalid", name)
		}
		if err := artifact.Validate(name); err != nil {
			return err
		}
	}
	if strings.ToLower(strings.TrimSpace(m.Signature.Algorithm)) != "ed25519" {
		return fmt.Errorf("release manifest signature algorithm must be ed25519")
	}
	if !safeKeyID(m.Signature.KeyID) {
		return fmt.Errorf("release manifest signature key_id is invalid")
	}
	if strings.TrimSpace(m.Signature.Value) == "" {
		return fmt.Errorf("release manifest signature value is required")
	}
	if strings.TrimSpace(m.SignedPayloadB64) != "" {
		payload, err := base64.StdEncoding.DecodeString(strings.TrimSpace(m.SignedPayloadB64))
		if err != nil {
			return fmt.Errorf("release manifest signed_payload_b64 is not valid base64: %w", err)
		}
		canonicalPayload, err := CanonicalSignedPayload(m.Signed)
		if err != nil {
			return err
		}
		if !bytes.Equal(payload, canonicalPayload) {
			return fmt.Errorf("release manifest signed_payload_b64 does not match signed object")
		}
	}
	return nil
}

func (a Artifact) Validate(name string) error {
	if err := validateHTTPSURL(a.URL, "artifact "+name+" url"); err != nil {
		return err
	}
	sha := strings.ToLower(strings.TrimSpace(a.SHA256))
	if len(sha) != 64 || !isHex(sha) {
		return fmt.Errorf("artifact %s sha256 must be 64 lowercase/uppercase hex characters", name)
	}
	if strings.TrimSpace(a.Signature) == "" {
		return fmt.Errorf("artifact %s signature is required", name)
	}
	return nil
}

func VerifyArtifactSignature(artifact Artifact, publicKeys []ed25519.PublicKey) error {
	if len(publicKeys) == 0 {
		return fmt.Errorf("no trusted artifact public keys are configured")
	}
	signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(artifact.Signature))
	if err != nil {
		return fmt.Errorf("artifact signature is not valid base64: %w", err)
	}
	payload := ArtifactSignaturePayload(artifact.SHA256)
	for _, publicKey := range publicKeys {
		if len(publicKey) != ed25519.PublicKeySize {
			continue
		}
		if ed25519.Verify(publicKey, payload, signature) {
			return nil
		}
	}
	return fmt.Errorf("artifact signature does not match any trusted public key")
}

func ArtifactSignaturePayload(sha256Hex string) []byte {
	return []byte("shellorchestra-artifact-sha256-v1\n" + strings.ToLower(strings.TrimSpace(sha256Hex)) + "\n")
}

func ArtifactDigestMatches(expected string, actual string) bool {
	expected = strings.ToLower(strings.TrimSpace(expected))
	actual = strings.ToLower(strings.TrimSpace(actual))
	if len(expected) != len(actual) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) == 1
}

func (m Manifest) Verify(publicKeys []ed25519.PublicKey) error {
	if len(publicKeys) == 0 {
		return fmt.Errorf("no trusted release manifest public keys are configured")
	}
	signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(m.Signature.Value))
	if err != nil {
		return fmt.Errorf("release manifest signature is not valid base64: %w", err)
	}
	payload, err := m.SignedPayload()
	if err != nil {
		return err
	}
	for _, publicKey := range publicKeys {
		if len(publicKey) != ed25519.PublicKeySize {
			continue
		}
		if ed25519.Verify(publicKey, payload, signature) {
			return nil
		}
	}
	return errNoTrustedKey
}

func (m Manifest) SignedPayload() ([]byte, error) {
	if strings.TrimSpace(m.SignedPayloadB64) != "" {
		payload, err := base64.StdEncoding.DecodeString(strings.TrimSpace(m.SignedPayloadB64))
		if err != nil {
			return nil, fmt.Errorf("release manifest signed_payload_b64 is not valid base64: %w", err)
		}
		return payload, nil
	}
	return CanonicalSignedPayload(m.Signed)
}

func CanonicalSignedPayload(signed SignedManifest) ([]byte, error) {
	// encoding/json emits struct fields in declaration order and sorts map keys.
	// Keep SignedManifest as a struct; do not replace it with map[string]any in signing tools.
	payload, err := json.Marshal(signed)
	if err != nil {
		return nil, fmt.Errorf("encode release manifest signed payload: %w", err)
	}
	return payload, nil
}

func ParseTrustedPublicKeys(rawValues []string) ([]ed25519.PublicKey, error) {
	keys := make([]ed25519.PublicKey, 0, len(rawValues))
	seen := map[string]bool{}
	for _, raw := range rawValues {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		key, err := parseTrustedPublicKey(raw)
		if err != nil {
			return nil, err
		}
		fingerprint := base64.StdEncoding.EncodeToString(key)
		if !seen[fingerprint] {
			seen[fingerprint] = true
			keys = append(keys, key)
		}
	}
	return keys, nil
}

func parseTrustedPublicKey(raw string) (ed25519.PublicKey, error) {
	value := raw
	if strings.HasPrefix(value, "ed25519:") {
		value = strings.TrimPrefix(value, "ed25519:")
	}
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return nil, fmt.Errorf("release manifest public key must be base64 raw Ed25519 public key: %w", err)
	}
	if len(decoded) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("release manifest public key has %d bytes, want %d", len(decoded), ed25519.PublicKeySize)
	}
	return ed25519.PublicKey(decoded), nil
}

func ParseVersion(raw string) (Version, error) {
	match := versionPattern.FindStringSubmatch(strings.TrimSpace(raw))
	if match == nil {
		return Version{}, fmt.Errorf("version must use major.minor.build numeric format")
	}
	parts := [3]int{}
	for index := 0; index < 3; index++ {
		value, err := strconv.Atoi(match[index+1])
		if err != nil {
			return Version{}, err
		}
		parts[index] = value
	}
	return Version{Major: parts[0], Minor: parts[1], Build: parts[2]}, nil
}

func CompareVersions(left string, right string) (int, error) {
	lv, err := ParseVersion(left)
	if err != nil {
		return 0, err
	}
	rv, err := ParseVersion(right)
	if err != nil {
		return 0, err
	}
	return lv.Compare(rv), nil
}

func (v Version) Compare(other Version) int {
	left := []int{v.Major, v.Minor, v.Build}
	right := []int{other.Major, other.Minor, other.Build}
	for index := range left {
		if left[index] < right[index] {
			return -1
		}
		if left[index] > right[index] {
			return 1
		}
	}
	return 0
}

func ArtifactNames(artifacts map[string]Artifact) []string {
	names := make([]string, 0, len(artifacts))
	for name := range artifacts {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func validateHTTPSURL(raw string, field string) error {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return fmt.Errorf("%s must be an absolute https URL", field)
	}
	if parsed.User != nil {
		return fmt.Errorf("%s must not contain credentials", field)
	}
	return nil
}

func safeToken(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 40 {
		return false
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return false
	}
	return true
}

func safeArtifactName(value string) bool { return safeToken(value) }

func safeKeyID(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 80 {
		return false
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			continue
		}
		return false
	}
	return true
}

func isHex(value string) bool {
	for _, r := range value {
		if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F') {
			continue
		}
		return false
	}
	return true
}
