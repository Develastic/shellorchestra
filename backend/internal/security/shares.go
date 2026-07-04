// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package security

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha512"
	"encoding/base64"
	"fmt"
	"strings"

	"golang.org/x/crypto/ssh"
)

const (
	ShareSize                    = 32
	classicFallbackKeyDeriveInfo = "shellorchestra classic ssh fallback key v1"
)

type AuthorityMaterial struct {
	Seed                    []byte
	PublicKeyOpenSSH        string
	ClassicSeed             []byte
	ClassicPublicKeyOpenSSH string
}

func GenerateAuthorityMaterial() (AuthorityMaterial, []byte, []byte, error) {
	seed := make([]byte, ShareSize)
	if _, err := rand.Read(seed); err != nil {
		return AuthorityMaterial{}, nil, nil, err
	}
	backendShare := make([]byte, ShareSize)
	if _, err := rand.Read(backendShare); err != nil {
		return AuthorityMaterial{}, nil, nil, err
	}
	deviceShare, err := DeriveDeviceShare(seed, backendShare)
	if err != nil {
		return AuthorityMaterial{}, nil, nil, err
	}
	material, err := MaterialFromSeed(seed)
	if err != nil {
		return AuthorityMaterial{}, nil, nil, err
	}
	return material, backendShare, deviceShare, nil
}

func MaterialFromOpenSSHPrivateKey(pemBytes []byte) (AuthorityMaterial, error) {
	key, err := ssh.ParseRawPrivateKey(pemBytes)
	if err != nil {
		return AuthorityMaterial{}, fmt.Errorf("imported private key must be an unencrypted OpenSSH Ed25519 private key: %w", err)
	}
	privateKey, ok := key.(ed25519.PrivateKey)
	if !ok {
		return AuthorityMaterial{}, fmt.Errorf("only Ed25519 private keys can be imported in this version")
	}
	seed := privateKey.Seed()
	return MaterialFromSeed(seed)
}

func MaterialFromOpenSSHKeyPair(privateKeyBytes []byte, publicKeyAuthorized string) (AuthorityMaterial, error) {
	if strings.TrimSpace(publicKeyAuthorized) == "" {
		return AuthorityMaterial{}, fmt.Errorf("public key is required when importing a private key")
	}
	material, err := MaterialFromOpenSSHPrivateKey(privateKeyBytes)
	if err != nil {
		return AuthorityMaterial{}, err
	}
	publicKey, _, _, _, err := ssh.ParseAuthorizedKey([]byte(strings.TrimSpace(publicKeyAuthorized)))
	if err != nil {
		return AuthorityMaterial{}, fmt.Errorf("public key must be an OpenSSH authorized-key line: %w", err)
	}
	canonical := string(bytes.TrimSpace(ssh.MarshalAuthorizedKey(publicKey)))
	if canonical != material.PublicKeyOpenSSH {
		return AuthorityMaterial{}, fmt.Errorf("public key does not match the imported private key")
	}
	return material, nil
}

func MaterialFromSeed(seed []byte) (AuthorityMaterial, error) {
	if len(seed) != ShareSize {
		return AuthorityMaterial{}, fmt.Errorf("seed must be %d bytes", ShareSize)
	}
	seedCopy := append([]byte(nil), seed...)
	publicKey, err := PublicKeyOpenSSHFromSeed(seedCopy)
	if err != nil {
		return AuthorityMaterial{}, err
	}
	classicSeed, err := ClassicFallbackSeedFromAuthoritySeed(seedCopy)
	if err != nil {
		return AuthorityMaterial{}, err
	}
	classicPublicKey, err := PublicKeyOpenSSHFromSeed(classicSeed)
	if err != nil {
		return AuthorityMaterial{}, err
	}
	return AuthorityMaterial{
		Seed:                    seedCopy,
		PublicKeyOpenSSH:        publicKey,
		ClassicSeed:             classicSeed,
		ClassicPublicKeyOpenSSH: classicPublicKey,
	}, nil
}

func DeriveDeviceShare(seed []byte, backendShare []byte) ([]byte, error) {
	if len(seed) != ShareSize || len(backendShare) != ShareSize {
		return nil, fmt.Errorf("seed and backend share must be %d bytes", ShareSize)
	}
	return xor(seed, backendShare), nil
}

func ReconstructSeed(backendShare []byte, deviceShare []byte) ([]byte, error) {
	if len(backendShare) != ShareSize || len(deviceShare) != ShareSize {
		return nil, fmt.Errorf("backend and device shares must be %d bytes", ShareSize)
	}
	return xor(backendShare, deviceShare), nil
}

func SignerFromShares(backendShareB64 string, deviceShareB64 string, expectedPublicKey string) (ssh.Signer, error) {
	seed, err := SeedFromShares(backendShareB64, deviceShareB64)
	if err != nil {
		return nil, err
	}
	signer, err := SignerFromSeed(seed)
	if err != nil {
		return nil, err
	}
	actual := string(bytes.TrimSpace(ssh.MarshalAuthorizedKey(signer.PublicKey())))
	if expectedPublicKey != "" && actual != expectedPublicKey {
		return nil, fmt.Errorf("device share does not reconstruct the configured ShellOrchestra key")
	}
	return signer, nil
}

func SeedFromShares(backendShareB64 string, deviceShareB64 string) ([]byte, error) {
	backendShare, err := base64.StdEncoding.DecodeString(backendShareB64)
	if err != nil {
		return nil, fmt.Errorf("backend share is invalid base64: %w", err)
	}
	deviceShare, err := base64.StdEncoding.DecodeString(deviceShareB64)
	if err != nil {
		return nil, fmt.Errorf("device share is invalid base64: %w", err)
	}
	return ReconstructSeed(backendShare, deviceShare)
}

func PublicKeyOpenSSHFromSeed(seed []byte) (string, error) {
	signer, err := SignerFromSeed(seed)
	if err != nil {
		return "", err
	}
	return string(bytes.TrimSpace(ssh.MarshalAuthorizedKey(signer.PublicKey()))), nil
}

func ClassicFallbackSeedFromAuthoritySeed(seed []byte) ([]byte, error) {
	if len(seed) != ShareSize {
		return nil, fmt.Errorf("seed must be %d bytes", ShareSize)
	}
	input := make([]byte, 0, len(classicFallbackKeyDeriveInfo)+1+len(seed))
	input = append(input, classicFallbackKeyDeriveInfo...)
	input = append(input, 0)
	input = append(input, seed...)
	digest := sha512.Sum512(input)
	classicSeed := make([]byte, ShareSize)
	copy(classicSeed, digest[:ShareSize])
	return classicSeed, nil
}

func B64(data []byte) string { return base64.StdEncoding.EncodeToString(data) }

func SignerFromSeed(seed []byte) (ssh.Signer, error) {
	if len(seed) != ShareSize {
		return nil, fmt.Errorf("seed must be %d bytes", ShareSize)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	return ssh.NewSignerFromKey(privateKey)
}

func xor(left []byte, right []byte) []byte {
	out := make([]byte, len(left))
	for i := range left {
		out[i] = left[i] ^ right[i]
	}
	return out
}
