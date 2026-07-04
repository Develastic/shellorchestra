// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
)

const (
	LANAuthorityKDFName     = "argon2id"
	lanAuthorityKDFTime     = uint32(3)
	lanAuthorityKDFMemoryKB = uint32(64 * 1024)
	lanAuthorityKDFThreads  = uint8(1)
	lanAuthorityKeyLength   = uint32(32)
)

type EncryptedSeed struct {
	CiphertextB64 string
	SaltB64       string
	NonceB64      string
	KDFName       string
	KDFParamsJSON string
}

type PassphraseVerifier struct {
	VerifierB64   string
	SaltB64       string
	KDFName       string
	KDFParamsJSON string
}

func GenerateTOTPSecret() (string, error) {
	secret := make([]byte, 20)
	if _, err := rand.Read(secret); err != nil {
		return "", err
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(secret), nil
}

func CreatePassphraseVerifier(passphrase string) (PassphraseVerifier, error) {
	if strings.TrimSpace(passphrase) == "" {
		return PassphraseVerifier{}, fmt.Errorf("admin passphrase is required")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return PassphraseVerifier{}, err
	}
	return PassphraseVerifier{
		VerifierB64:   base64.StdEncoding.EncodeToString(passphraseVerifierDigest(passphrase, salt)),
		SaltB64:       base64.StdEncoding.EncodeToString(salt),
		KDFName:       LANAuthorityKDFName,
		KDFParamsJSON: fmt.Sprintf(`{"time":%d,"memory_kb":%d,"threads":%d}`, lanAuthorityKDFTime, lanAuthorityKDFMemoryKB, lanAuthorityKDFThreads),
	}, nil
}

func VerifyPassphrase(verifier PassphraseVerifier, passphrase string) bool {
	if strings.TrimSpace(passphrase) == "" || verifier.VerifierB64 == "" || verifier.SaltB64 == "" {
		return false
	}
	if verifier.KDFName != "" && verifier.KDFName != LANAuthorityKDFName {
		return false
	}
	expected, err := base64.StdEncoding.DecodeString(verifier.VerifierB64)
	if err != nil {
		return false
	}
	salt, err := base64.StdEncoding.DecodeString(verifier.SaltB64)
	if err != nil {
		return false
	}
	actual := passphraseVerifierDigest(passphrase, salt)
	return hmac.Equal(actual, expected)
}

func TOTPAuthURL(issuer string, account string, secret string) string {
	issuer = strings.TrimSpace(issuer)
	if issuer == "" {
		issuer = "ShellOrchestra"
	}
	account = strings.TrimSpace(account)
	if account == "" {
		account = "admin"
	}
	values := url.Values{}
	values.Set("secret", strings.ToUpper(strings.TrimSpace(secret)))
	values.Set("issuer", issuer)
	return "otpauth://totp/" + url.PathEscape(issuer+":"+account) + "?" + values.Encode()
}

func VerifyTOTPCode(secret string, code string, now time.Time) bool {
	normalized := strings.TrimSpace(strings.ReplaceAll(code, " ", ""))
	if len(normalized) != 6 {
		return false
	}
	for _, r := range normalized {
		if r < '0' || r > '9' {
			return false
		}
	}
	for offset := int64(-1); offset <= 1; offset++ {
		expected, err := totpCode(secret, now.Add(time.Duration(offset)*30*time.Second))
		if err != nil {
			return false
		}
		if hmac.Equal([]byte(normalized), []byte(expected)) {
			return true
		}
	}
	return false
}

func EncryptSeedWithPassphrase(seed []byte, passphrase string) (EncryptedSeed, error) {
	if len(seed) != ShareSize {
		return EncryptedSeed{}, fmt.Errorf("seed must be %d bytes", ShareSize)
	}
	if strings.TrimSpace(passphrase) == "" {
		return EncryptedSeed{}, fmt.Errorf("admin passphrase is required")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return EncryptedSeed{}, err
	}
	nonce := make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		return EncryptedSeed{}, err
	}
	key := deriveLANAuthorityKey(passphrase, salt)
	block, err := aes.NewCipher(key)
	if err != nil {
		return EncryptedSeed{}, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return EncryptedSeed{}, err
	}
	ciphertext := aead.Seal(nil, nonce, seed, nil)
	return EncryptedSeed{
		CiphertextB64: base64.StdEncoding.EncodeToString(ciphertext),
		SaltB64:       base64.StdEncoding.EncodeToString(salt),
		NonceB64:      base64.StdEncoding.EncodeToString(nonce),
		KDFName:       LANAuthorityKDFName,
		KDFParamsJSON: fmt.Sprintf(`{"time":%d,"memory_kb":%d,"threads":%d}`, lanAuthorityKDFTime, lanAuthorityKDFMemoryKB, lanAuthorityKDFThreads),
	}, nil
}

func DecryptSeedWithPassphrase(encrypted EncryptedSeed, passphrase string) ([]byte, error) {
	if strings.TrimSpace(passphrase) == "" {
		return nil, fmt.Errorf("admin passphrase is required")
	}
	if encrypted.KDFName != "" && encrypted.KDFName != LANAuthorityKDFName {
		return nil, fmt.Errorf("unsupported authority KDF %q", encrypted.KDFName)
	}
	salt, err := base64.StdEncoding.DecodeString(encrypted.SaltB64)
	if err != nil {
		return nil, fmt.Errorf("authority salt is invalid base64: %w", err)
	}
	nonce, err := base64.StdEncoding.DecodeString(encrypted.NonceB64)
	if err != nil {
		return nil, fmt.Errorf("authority nonce is invalid base64: %w", err)
	}
	ciphertext, err := base64.StdEncoding.DecodeString(encrypted.CiphertextB64)
	if err != nil {
		return nil, fmt.Errorf("encrypted authority is invalid base64: %w", err)
	}
	key := deriveLANAuthorityKey(passphrase, salt)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	seed, err := aead.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("admin passphrase or one-time code is incorrect")
	}
	if len(seed) != ShareSize {
		return nil, fmt.Errorf("decrypted seed must be %d bytes", ShareSize)
	}
	return seed, nil
}

func deriveLANAuthorityKey(passphrase string, salt []byte) []byte {
	return argon2.IDKey([]byte(passphrase), salt, lanAuthorityKDFTime, lanAuthorityKDFMemoryKB, lanAuthorityKDFThreads, lanAuthorityKeyLength)
}

func passphraseVerifierDigest(passphrase string, salt []byte) []byte {
	key := deriveLANAuthorityKey(passphrase, salt)
	sum := sha256.Sum256(append(key, []byte("ShellOrchestra LAN admin passphrase verifier v1")...))
	return sum[:]
}

func totpCode(secret string, now time.Time) (string, error) {
	decoded, err := decodeTOTPSecret(secret)
	if err != nil {
		return "", err
	}
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(now.Unix()/30))
	mac := hmac.New(sha1.New, decoded)
	if _, err := mac.Write(counter[:]); err != nil {
		return "", err
	}
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	binaryCode := (uint32(sum[offset])&0x7f)<<24 |
		(uint32(sum[offset+1])&0xff)<<16 |
		(uint32(sum[offset+2])&0xff)<<8 |
		(uint32(sum[offset+3]) & 0xff)
	return fmt.Sprintf("%06d", int(binaryCode%1_000_000)), nil
}

func decodeTOTPSecret(secret string) ([]byte, error) {
	normalized := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(secret), " ", ""))
	return base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(normalized)
}
