// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package releases

import (
	"context"
	"crypto/ed25519"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const MaxManifestBytes int64 = 256 << 10

type CheckOptions struct {
	Enabled              bool
	CurrentVersion       string
	CurrentEdition       string
	Channel              string
	ManifestURL          string
	ManifestMirrorURLs   []string
	KeyringURL           string
	KeyringMirrorURLs    []string
	RootPublicKeys       []ed25519.PublicKey
	TrustedPublicKeys    []ed25519.PublicKey
	InstallMethod        string
	UpdaterAvailable     bool
	ManualUpgradeCommand string
	ManualUpgradeURL     string
	HTTPClient           *http.Client
	Now                  func() time.Time
}

type CheckResult struct {
	Status                string    `json:"status"`
	CurrentVersion        string    `json:"current_version"`
	CurrentEdition        string    `json:"current_edition"`
	Channel               string    `json:"channel"`
	LatestVersion         string    `json:"latest_version,omitempty"`
	UpdateAvailable       bool      `json:"update_available"`
	Critical              bool      `json:"critical"`
	MinimumSupported      string    `json:"minimum_supported,omitempty"`
	ReleaseNotesURL       string    `json:"release_notes_url,omitempty"`
	OneClickAvailable     bool      `json:"one_click_available"`
	ManualUpgradeRequired bool      `json:"manual_upgrade_required"`
	InstallMethod         string    `json:"install_method"`
	ManualUpgradeCommand  string    `json:"manual_upgrade_command,omitempty"`
	ManualUpgradeURL      string    `json:"manual_upgrade_url,omitempty"`
	Message               string    `json:"message"`
	CheckedAt             time.Time `json:"checked_at"`
	Artifacts             []string  `json:"artifacts,omitempty"`
}

func Check(ctx context.Context, options CheckOptions) CheckResult {
	now := time.Now().UTC()
	if options.Now != nil {
		now = options.Now().UTC()
	}
	currentVersion := strings.TrimSpace(options.CurrentVersion)
	if currentVersion == "" {
		currentVersion = "0.0.0"
	}
	currentEdition := strings.TrimSpace(options.CurrentEdition)
	if currentEdition == "" {
		currentEdition = "community"
	}
	channel := strings.TrimSpace(options.Channel)
	if channel == "" {
		channel = "stable"
	}
	installMethod := normalizeInstallMethod(options.InstallMethod)
	result := CheckResult{
		Status:               "ok",
		CurrentVersion:       currentVersion,
		CurrentEdition:       currentEdition,
		Channel:              channel,
		InstallMethod:        installMethod,
		ManualUpgradeCommand: strings.TrimSpace(options.ManualUpgradeCommand),
		ManualUpgradeURL:     strings.TrimSpace(options.ManualUpgradeURL),
		CheckedAt:            now,
	}
	if !options.Enabled {
		result.Status = "disabled"
		result.Message = "Update checks are disabled for this installation."
		return result
	}
	if len(options.RootPublicKeys) == 0 && len(options.TrustedPublicKeys) == 0 {
		result.Status = "not_configured"
		result.Message = "Update checks need a trusted ShellOrchestra release root key or legacy release public key before release manifests can be verified."
		return result
	}
	manifestURL := strings.TrimSpace(options.ManifestURL)
	if manifestURL == "" {
		result.Status = "not_configured"
		result.Message = "Update checks need a release manifest URL."
		return result
	}
	client := options.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	fetchResult, err := FetchAndVerifyManifest(ctx, TrustOptions{
		ManifestURL:        manifestURL,
		ManifestMirrorURLs: options.ManifestMirrorURLs,
		KeyringURL:         options.KeyringURL,
		KeyringMirrorURLs:  options.KeyringMirrorURLs,
		RootPublicKeys:     options.RootPublicKeys,
		DirectPublicKeys:   options.TrustedPublicKeys,
		Channel:            channel,
		HTTPClient:         client,
		Now:                func() time.Time { return now },
	})
	if err != nil {
		result.Status = "error"
		result.Message = "ShellOrchestra could not verify the signed release manifest: " + err.Error()
		return result
	}
	manifest := fetchResult.Manifest
	if manifest.Signed.Channel != channel {
		result.Status = "error"
		result.Message = fmt.Sprintf("Signed release manifest channel %q does not match configured channel %q.", manifest.Signed.Channel, channel)
		return result
	}
	comparison, err := CompareVersions(manifest.Signed.Latest, currentVersion)
	if err != nil {
		result.Status = "error"
		result.Message = "ShellOrchestra could not compare release versions: " + err.Error()
		return result
	}
	result.LatestVersion = manifest.Signed.Latest
	result.Critical = manifest.Signed.Critical
	result.MinimumSupported = manifest.Signed.MinimumSupported
	result.ReleaseNotesURL = manifest.Signed.ReleaseNotesURL
	result.Artifacts = ArtifactNames(manifest.Signed.Artifacts)
	belowMinimumSupported := false
	if strings.TrimSpace(manifest.Signed.MinimumSupported) != "" {
		minimumComparison, err := CompareVersions(currentVersion, manifest.Signed.MinimumSupported)
		if err != nil {
			result.Status = "error"
			result.Message = "ShellOrchestra could not compare minimum supported release versions: " + err.Error()
			return result
		}
		belowMinimumSupported = minimumComparison < 0
	}
	result.UpdateAvailable = comparison > 0 || belowMinimumSupported
	if belowMinimumSupported {
		result.ManualUpgradeRequired = true
		result.Critical = true
		result.ManualUpgradeCommand = ""
	} else if options.UpdaterAvailable {
		_, hasCompatibleArtifact := manifest.Signed.Artifacts[artifactForInstallMethod(installMethod)]
		result.OneClickAvailable = result.UpdateAvailable && hasCompatibleArtifact
	}
	if result.UpdateAvailable {
		if result.ManualUpgradeRequired {
			result.Message = fmt.Sprintf("This ShellOrchestra installation is below the minimum supported version %s for the signed release channel. Follow the manual upgrade runbook and release notes before using one-click updates again.", result.MinimumSupported)
		} else if result.OneClickAvailable {
			result.Message = fmt.Sprintf("ShellOrchestra %s is available and can be installed with the local updater.", result.LatestVersion)
		} else if strings.TrimSpace(result.ManualUpgradeCommand) != "" {
			result.Message = fmt.Sprintf("ShellOrchestra %s is available. Copy and run the manual upgrade command for this installation.", result.LatestVersion)
		} else if strings.TrimSpace(result.ManualUpgradeURL) != "" {
			result.Message = fmt.Sprintf("ShellOrchestra %s is available. Follow the manual upgrade runbook for this installation.", result.LatestVersion)
		} else {
			result.Message = fmt.Sprintf("ShellOrchestra %s is available. Manual upgrade instructions are not configured for this installation.", result.LatestVersion)
		}
	} else {
		result.Message = "This ShellOrchestra installation is up to date."
	}
	return result
}

func normalizeInstallMethod(value string) string {
	switch strings.TrimSpace(strings.ToLower(value)) {
	case "official", "manual", "windows_app":
		return strings.TrimSpace(strings.ToLower(value))
	default:
		return "unknown"
	}
}

func artifactForInstallMethod(method string) string {
	switch method {
	case "windows_app":
		return "windows"
	default:
		return "docker"
	}
}
