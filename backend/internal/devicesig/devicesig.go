// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package devicesig

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"math/big"
	"strings"
)

const (
	HeaderDeviceID  = "X-ShellOrchestra-Device-ID"
	HeaderSessionID = "X-ShellOrchestra-Session-ID"
	HeaderTimestamp = "X-ShellOrchestra-Timestamp"
	HeaderNonce     = "X-ShellOrchestra-Nonce"
	HeaderBodyHash  = "X-ShellOrchestra-Body-SHA256"
	HeaderSignature = "X-ShellOrchestra-Signature"
)

type RequestProof struct {
	Method    string
	PathQuery string
	BodyHash  string
	Timestamp string
	Nonce     string
	DeviceID  string
	SessionID string
	Signature string
}

func BodyHash(data []byte) string {
	sum := sha256.Sum256(data)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func CanonicalRequest(proof RequestProof) []byte {
	lines := []string{
		strings.ToUpper(strings.TrimSpace(proof.Method)),
		strings.TrimSpace(proof.PathQuery),
		strings.TrimSpace(proof.BodyHash),
		strings.TrimSpace(proof.Timestamp),
		strings.TrimSpace(proof.Nonce),
		strings.TrimSpace(proof.DeviceID),
		strings.TrimSpace(proof.SessionID),
	}
	return []byte(strings.Join(lines, "\n"))
}

func ValidatePublicKey(publicKeySPKIB64 string) error {
	_, err := parsePublicKey(publicKeySPKIB64)
	return err
}

func parsePublicKey(publicKeySPKIB64 string) (*ecdsa.PublicKey, error) {
	publicKeyDER, err := base64.StdEncoding.DecodeString(strings.TrimSpace(publicKeySPKIB64))
	if err != nil {
		return nil, fmt.Errorf("device signing public key is not valid base64: %w", err)
	}
	parsed, err := x509.ParsePKIXPublicKey(publicKeyDER)
	if err != nil {
		return nil, fmt.Errorf("device signing public key is invalid: %w", err)
	}
	publicKey, ok := parsed.(*ecdsa.PublicKey)
	if !ok || publicKey.Curve == nil || publicKey.Curve.Params().BitSize != 256 {
		return nil, fmt.Errorf("device signing public key must be an ECDSA P-256 key")
	}
	return publicKey, nil
}

func VerifyRequest(proof RequestProof, publicKeySPKIB64 string) error {
	if strings.TrimSpace(proof.DeviceID) == "" || strings.TrimSpace(proof.SessionID) == "" || strings.TrimSpace(proof.Nonce) == "" || strings.TrimSpace(proof.Timestamp) == "" || strings.TrimSpace(proof.BodyHash) == "" || strings.TrimSpace(proof.Signature) == "" {
		return fmt.Errorf("request signature headers are incomplete")
	}
	publicKey, err := parsePublicKey(publicKeySPKIB64)
	if err != nil {
		return err
	}
	signature, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(proof.Signature))
	if err != nil {
		return fmt.Errorf("request signature is not valid base64url: %w", err)
	}
	if len(signature) != 64 {
		return fmt.Errorf("request signature must be a raw P-256 ECDSA signature")
	}
	digest := sha256.Sum256(CanonicalRequest(proof))
	r := new(big.Int).SetBytes(signature[:32])
	s := new(big.Int).SetBytes(signature[32:])
	if !ecdsa.Verify(publicKey, digest[:], r, s) {
		return fmt.Errorf("request signature is invalid")
	}
	return nil
}
