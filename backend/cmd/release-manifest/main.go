// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"shellorchestra/backend/internal/releases"
)

type artifactFlag []string

func (f *artifactFlag) String() string { return strings.Join(*f, ",") }
func (f *artifactFlag) Set(value string) error {
	*f = append(*f, value)
	return nil
}

type stringFlag []string

func (f *stringFlag) String() string { return strings.Join(*f, ",") }
func (f *stringFlag) Set(value string) error {
	*f = append(*f, value)
	return nil
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "gen-key":
		genKey(os.Args[2:])
	case "sign":
		sign(os.Args[2:])
	case "sign-keyring":
		signKeyring(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
}

func genKey(args []string) {
	fs := flag.NewFlagSet("gen-key", flag.ExitOnError)
	privatePath := fs.String("private-key", "", "Path for base64 raw Ed25519 private key, created 0600")
	publicPath := fs.String("public-key", "", "Path for base64 raw Ed25519 public key")
	publicPEMPath := fs.String("public-key-pem", "", "Optional path for PEM/SPKI Ed25519 public key used by shell installers")
	_ = fs.Parse(args)
	if *privatePath == "" || *publicPath == "" {
		fatal("--private-key and --public-key are required")
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		fatal(err.Error())
	}
	writeFileExclusive(*privatePath, []byte(base64.StdEncoding.EncodeToString(privateKey)+"\n"), 0o600)
	writeFileExclusive(*publicPath, []byte(base64.StdEncoding.EncodeToString(publicKey)+"\n"), 0o644)
	if strings.TrimSpace(*publicPEMPath) != "" {
		writeFileExclusive(*publicPEMPath, ed25519PublicKeyPEM(publicKey), 0o644)
	}
	fmt.Printf("Release keypair generated. Public key: %s\n", base64.StdEncoding.EncodeToString(publicKey))
}

func sign(args []string) {
	fs := flag.NewFlagSet("sign", flag.ExitOnError)
	privatePath := fs.String("private-key", "", "Base64 raw Ed25519 private key file")
	keyID := fs.String("key-id", "", "Release signing key id")
	channel := fs.String("channel", "stable", "Release channel")
	version := fs.String("version", "", "Latest ShellOrchestra version")
	minimumSupported := fs.String("minimum-supported", "0.1.0", "Minimum supported ShellOrchestra version")
	releaseNotesURL := fs.String("release-notes-url", "", "HTTPS release notes URL")
	critical := fs.Bool("critical", false, "Mark release as critical")
	outPath := fs.String("out", "", "Output manifest JSON path")
	var artifacts artifactFlag
	fs.Var(&artifacts, "artifact", "Artifact in name=url=path form; repeatable")
	_ = fs.Parse(args)
	if *privatePath == "" || *keyID == "" || *version == "" || *releaseNotesURL == "" || *outPath == "" || len(artifacts) == 0 {
		fatal("--private-key, --key-id, --version, --release-notes-url, --out, and at least one --artifact are required")
	}
	privateKey := readPrivateKey(*privatePath)
	artifactMap := map[string]releases.Artifact{}
	for _, raw := range artifacts {
		name, url, path := parseArtifact(raw)
		sha := sha256File(path)
		artifactMap[name] = releases.Artifact{URL: url, SHA256: sha, Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, releases.ArtifactSignaturePayload(sha)))}
	}
	signed := releases.SignedManifest{Product: "ShellOrchestra", Channel: *channel, Latest: *version, ReleasedAt: time.Now().UTC(), MinimumSupported: *minimumSupported, Critical: *critical, ReleaseNotesURL: *releaseNotesURL, Artifacts: artifactMap}
	payload, err := releases.CanonicalSignedPayload(signed)
	if err != nil {
		fatal(err.Error())
	}
	manifest := releases.Manifest{Schema: releases.SchemaV1, Signed: signed, SignedPayloadB64: base64.StdEncoding.EncodeToString(payload), Signature: releases.SignatureBlock{Algorithm: "ed25519", KeyID: *keyID, Value: base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))}}
	if err := manifest.ValidateStructure(); err != nil {
		fatal(err.Error())
	}
	if err := manifest.Verify([]ed25519.PublicKey{privateKey.Public().(ed25519.PublicKey)}); err != nil {
		fatal(err.Error())
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		fatal(err.Error())
	}
	if err := os.MkdirAll(filepath.Dir(*outPath), 0o755); err != nil {
		fatal(err.Error())
	}
	if err := os.WriteFile(*outPath, append(data, '\n'), 0o644); err != nil {
		fatal(err.Error())
	}
	fmt.Printf("Signed release manifest written to %s\n", *outPath)
}

func signKeyring(args []string) {
	fs := flag.NewFlagSet("sign-keyring", flag.ExitOnError)
	rootPrivatePath := fs.String("root-private-key", "", "Base64 raw Ed25519 root private key file")
	rootKeyID := fs.String("root-key-id", "", "Offline root signing key id")
	version := fs.Int("version", 1, "Monotonic keyring version")
	expiresDays := fs.Int("expires-days", 365, "Keyring expiration window in days")
	outPath := fs.String("out", "", "Output keyring JSON path")
	var releaseKeys stringFlag
	var mirrors stringFlag
	var revoked stringFlag
	fs.Var(&releaseKeys, "release-key", "Release key in key-id=public-key-path=valid-days=channels form; channels is comma-separated or *; repeatable")
	fs.Var(&mirrors, "mirror", "Mirror in name=keyring-url=manifest-url form; repeatable")
	fs.Var(&revoked, "revoked-key-id", "Revoked release key id; repeatable")
	_ = fs.Parse(args)
	if *rootPrivatePath == "" || *rootKeyID == "" || *outPath == "" || len(releaseKeys) == 0 {
		fatal("--root-private-key, --root-key-id, --out, and at least one --release-key are required")
	}
	if *version <= 0 {
		fatal("--version must be positive")
	}
	if *expiresDays <= 0 || *expiresDays > 3660 {
		fatal("--expires-days must be between 1 and 3660")
	}
	rootPrivateKey := readPrivateKey(*rootPrivatePath)
	now := time.Now().UTC().Truncate(time.Second)
	signed := releases.SignedKeyring{
		Product:       "ShellOrchestra",
		Version:       *version,
		IssuedAt:      now,
		ExpiresAt:     now.AddDate(0, 0, *expiresDays),
		ReleaseKeys:   make([]releases.ReleaseKey, 0, len(releaseKeys)),
		RevokedKeyIDs: []string(revoked),
		Mirrors:       make([]releases.ReleaseMirror, 0, len(mirrors)),
	}
	for _, raw := range releaseKeys {
		keyID, publicKeyPath, validDays, channels := parseReleaseKey(raw)
		publicKey := strings.TrimSpace(string(readFile(publicKeyPath)))
		signed.ReleaseKeys = append(signed.ReleaseKeys, releases.ReleaseKey{
			KeyID:      keyID,
			PublicKey:  publicKey,
			ValidFrom:  now,
			ValidUntil: now.AddDate(0, 0, validDays),
			Channels:   channels,
		})
	}
	for _, raw := range mirrors {
		name, keyringURL, manifestURL := parseMirror(raw)
		signed.Mirrors = append(signed.Mirrors, releases.ReleaseMirror{Name: name, KeyringURL: keyringURL, ManifestURL: manifestURL})
	}
	payload, err := releases.CanonicalKeyringSignedPayload(signed)
	if err != nil {
		fatal(err.Error())
	}
	keyring := releases.Keyring{
		Schema:           releases.KeyringSchemaV1,
		Signed:           signed,
		SignedPayloadB64: base64.StdEncoding.EncodeToString(payload),
		Signature:        releases.SignatureBlock{Algorithm: "ed25519", KeyID: *rootKeyID, Value: base64.StdEncoding.EncodeToString(ed25519.Sign(rootPrivateKey, payload))},
	}
	if err := keyring.ValidateStructure(); err != nil {
		fatal(err.Error())
	}
	if err := keyring.Verify([]ed25519.PublicKey{rootPrivateKey.Public().(ed25519.PublicKey)}); err != nil {
		fatal(err.Error())
	}
	data, err := json.MarshalIndent(keyring, "", "  ")
	if err != nil {
		fatal(err.Error())
	}
	if err := os.MkdirAll(filepath.Dir(*outPath), 0o755); err != nil {
		fatal(err.Error())
	}
	if err := os.WriteFile(*outPath, append(data, '\n'), 0o644); err != nil {
		fatal(err.Error())
	}
	fmt.Printf("Signed release keyring written to %s\n", *outPath)
}

func readPrivateKey(path string) ed25519.PrivateKey {
	data, err := os.ReadFile(path)
	if err != nil {
		fatal(err.Error())
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
	if err != nil {
		fatal("private key must be base64 raw Ed25519 private key")
	}
	if len(decoded) != ed25519.PrivateKeySize {
		fatal(fmt.Sprintf("private key has %d bytes, want %d", len(decoded), ed25519.PrivateKeySize))
	}
	return ed25519.PrivateKey(decoded)
}

func readFile(path string) []byte {
	data, err := os.ReadFile(path)
	if err != nil {
		fatal(err.Error())
	}
	return data
}

func parseArtifact(raw string) (string, string, string) {
	parts := strings.SplitN(raw, "=", 3)
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		fatal("--artifact must use name=url=path")
	}
	return parts[0], parts[1], parts[2]
}

func parseReleaseKey(raw string) (string, string, int, []string) {
	parts := strings.SplitN(raw, "=", 4)
	if len(parts) != 4 || parts[0] == "" || parts[1] == "" || parts[2] == "" || parts[3] == "" {
		fatal("--release-key must use key-id=public-key-path=valid-days=channels")
	}
	days, err := strconv.Atoi(parts[2])
	if err != nil || days <= 0 || days > 3660 {
		fatal("--release-key valid-days must be between 1 and 3660")
	}
	var channels []string
	if parts[3] != "*" {
		for _, channel := range strings.Split(parts[3], ",") {
			channel = strings.TrimSpace(channel)
			if channel != "" {
				channels = append(channels, channel)
			}
		}
		if len(channels) == 0 {
			fatal("--release-key channels must not be empty")
		}
	}
	return parts[0], parts[1], days, channels
}

func parseMirror(raw string) (string, string, string) {
	parts := strings.SplitN(raw, "=", 3)
	if len(parts) != 3 || parts[0] == "" {
		fatal("--mirror must use name=keyring-url=manifest-url")
	}
	return parts[0], parts[1], parts[2]
}

func sha256File(path string) string {
	file, err := os.Open(path)
	if err != nil {
		fatal(err.Error())
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		fatal(err.Error())
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func writeFileExclusive(path string, data []byte, mode os.FileMode) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		fatal(err.Error())
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		fatal(err.Error())
	}
	defer file.Close()
	if _, err := file.Write(data); err != nil {
		fatal(err.Error())
	}
}

func ed25519PublicKeyPEM(publicKey ed25519.PublicKey) []byte {
	if len(publicKey) != ed25519.PublicKeySize {
		fatal(fmt.Sprintf("public key has %d bytes, want %d", len(publicKey), ed25519.PublicKeySize))
	}
	derPrefix := []byte{0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00}
	der := append(append([]byte{}, derPrefix...), publicKey...)
	return pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
}

func usage() {
	fmt.Fprintf(os.Stderr, "Usage:\n  release-manifest gen-key --private-key /secure/shellorchestra/release.ed25519 --public-key /secure/shellorchestra/release.ed25519.pub --public-key-pem /secure/shellorchestra/release.ed25519.pub.pem\n  release-manifest sign --private-key /secure/shellorchestra/release.ed25519 --key-id shellorchestra-release-2026q3 --version 0.1.734 --release-notes-url https://shellorchestra.com/releases/0.1.734 --artifact docker=https://shellorchestra.com/releases/0.1.734/shellorchestra-docker.tar.zst=/artifacts/shellorchestra-docker.tar.zst --out product-site/public/releases/stable.json\n  release-manifest sign-keyring --root-private-key /secure/shellorchestra/root.ed25519 --root-key-id shellorchestra-root-2026 --release-key shellorchestra-release-2026q3=/secure/shellorchestra/release.ed25519.pub=180=stable --out product-site/public/releases/keyring.json\n")
}

func fatal(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
