// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package releases

import (
	"context"
	"crypto/ed25519"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const MaxKeyringBytes int64 = 512 << 10

type TrustOptions struct {
	ManifestURL        string
	ManifestMirrorURLs []string
	KeyringURL         string
	KeyringMirrorURLs  []string
	RootPublicKeys     []ed25519.PublicKey
	DirectPublicKeys   []ed25519.PublicKey
	Channel            string
	HTTPClient         *http.Client
	Now                func() time.Time
}

type FetchResult struct {
	Manifest          Manifest
	Keyring           Keyring
	ReleasePublicKeys []ed25519.PublicKey
	ReleaseKeyIDs     []string
	ManifestURL       string
	KeyringURL        string
	UsedKeyring       bool
}

func FetchAndVerifyManifest(ctx context.Context, options TrustOptions) (FetchResult, error) {
	now := time.Now().UTC()
	if options.Now != nil {
		now = options.Now().UTC()
	}
	client := options.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	manifestURL := strings.TrimSpace(options.ManifestURL)
	if manifestURL == "" {
		return FetchResult{}, fmt.Errorf("updates.manifest_url is required")
	}

	var keyring Keyring
	keyringURL := ""
	useKeyring := len(options.RootPublicKeys) > 0 && strings.TrimSpace(options.KeyringURL) != ""
	manifestURLs := appendURLList([]string{manifestURL}, options.ManifestMirrorURLs)
	if useKeyring {
		data, usedURL, err := fetchJSON(ctx, client, appendURLList([]string{options.KeyringURL}, options.KeyringMirrorURLs), MaxKeyringBytes, "release keyring")
		if err != nil {
			return FetchResult{}, err
		}
		keyringURL = usedURL
		decoded, err := DecodeKeyring(data)
		if err != nil {
			return FetchResult{}, err
		}
		if err := decoded.Verify(options.RootPublicKeys); err != nil {
			return FetchResult{}, err
		}
		keyring = decoded
		for _, mirror := range keyring.Signed.Mirrors {
			if strings.TrimSpace(mirror.ManifestURL) != "" {
				manifestURLs = append(manifestURLs, strings.TrimSpace(mirror.ManifestURL))
			}
		}
		manifestURLs = appendURLList(nil, manifestURLs)
	}

	data, usedManifestURL, err := fetchJSON(ctx, client, manifestURLs, MaxManifestBytes, "release manifest")
	if err != nil {
		return FetchResult{}, err
	}
	manifest, err := DecodeManifest(data)
	if err != nil {
		return FetchResult{}, err
	}

	var publicKeys []ed25519.PublicKey
	var keyIDs []string
	if useKeyring {
		publicKeys, keyIDs, err = keyring.ReleasePublicKeys(manifest.Signed.Channel, manifest.Signature.KeyID, now)
		if err != nil {
			return FetchResult{}, err
		}
	} else {
		publicKeys = options.DirectPublicKeys
	}
	if len(publicKeys) == 0 {
		if useKeyring {
			return FetchResult{}, fmt.Errorf("release keyring did not provide a trusted release key")
		}
		return FetchResult{}, fmt.Errorf("no trusted release manifest public keys are configured")
	}
	if err := manifest.Verify(publicKeys); err != nil {
		return FetchResult{}, err
	}
	return FetchResult{
		Manifest:          manifest,
		Keyring:           keyring,
		ReleasePublicKeys: publicKeys,
		ReleaseKeyIDs:     keyIDs,
		ManifestURL:       usedManifestURL,
		KeyringURL:        keyringURL,
		UsedKeyring:       useKeyring,
	}, nil
}

func fetchJSON(ctx context.Context, client *http.Client, urls []string, limit int64, label string) ([]byte, string, error) {
	urls = appendURLList(nil, urls)
	if len(urls) == 0 {
		return nil, "", fmt.Errorf("%s URL is required", label)
	}
	var failures []string
	for _, rawURL := range urls {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
		if err != nil {
			failures = append(failures, rawURL+": "+err.Error())
			continue
		}
		req.Header.Set("Accept", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			failures = append(failures, rawURL+": "+err.Error())
			continue
		}
		data, readErr := io.ReadAll(io.LimitReader(resp.Body, limit+1))
		closeErr := resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			failures = append(failures, fmt.Sprintf("%s: HTTP %d", rawURL, resp.StatusCode))
			continue
		}
		if readErr != nil {
			failures = append(failures, rawURL+": "+readErr.Error())
			continue
		}
		if closeErr != nil {
			failures = append(failures, rawURL+": "+closeErr.Error())
			continue
		}
		if int64(len(data)) > limit {
			failures = append(failures, fmt.Sprintf("%s: body exceeds %d bytes", rawURL, limit))
			continue
		}
		return data, rawURL, nil
	}
	return nil, "", fmt.Errorf("could not download %s from trusted URL list: %s", label, strings.Join(failures, "; "))
}

func appendURLList(prefix []string, values []string) []string {
	result := make([]string, 0, len(prefix)+len(values))
	seen := map[string]bool{}
	for _, value := range append(prefix, values...) {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}
