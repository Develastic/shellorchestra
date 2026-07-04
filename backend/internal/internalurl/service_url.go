// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package internalurl

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

const AppRunnerUnixSocketPath = "/app/app-runner/app-runner.sock"

// ParseServiceURL accepts only an internal service origin: scheme, host, and optional port.
func ParseServiceURL(raw string, field string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("%s must be an absolute HTTP(S) URL", field)
	}
	if !strings.EqualFold(parsed.Scheme, "http") && !strings.EqualFold(parsed.Scheme, "https") {
		return nil, fmt.Errorf("%s must use http or https", field)
	}
	if parsed.User != nil {
		return nil, fmt.Errorf("%s must not include userinfo", field)
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("%s must not include query or fragment", field)
	}
	path := parsed.EscapedPath()
	if path != "" && path != "/" {
		return nil, fmt.Errorf("%s must be a service origin without a path", field)
	}
	parsed.Path = ""
	parsed.RawPath = ""
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed, nil
}

type ServiceEndpoint struct {
	URL            *url.URL
	UnixSocketPath string
}

func ParseServiceOrUnixSocketURL(raw string, field string) (ServiceEndpoint, error) {
	trimmed := strings.TrimSpace(raw)
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" {
		return ServiceEndpoint{}, fmt.Errorf("%s must be an absolute HTTP(S) URL or unix socket URL", field)
	}
	if strings.EqualFold(parsed.Scheme, "unix") {
		socketPath, err := validateUnixSocketURL(parsed, field)
		if err != nil {
			return ServiceEndpoint{}, err
		}
		return ServiceEndpoint{URL: &url.URL{Scheme: "http", Host: "app-runner.unix"}, UnixSocketPath: socketPath}, nil
	}
	serviceURL, err := ParseServiceURL(trimmed, field)
	if err != nil {
		return ServiceEndpoint{}, err
	}
	return ServiceEndpoint{URL: serviceURL}, nil
}

func HTTPClient(timeout time.Duration, unixSocketPath string) *http.Client {
	if strings.TrimSpace(unixSocketPath) == "" {
		return &http.Client{Timeout: timeout}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = func(ctx context.Context, network string, address string) (net.Conn, error) {
		dialer := net.Dialer{}
		return dialer.DialContext(ctx, "unix", unixSocketPath)
	}
	return &http.Client{Timeout: timeout, Transport: transport}
}

func validateUnixSocketURL(parsed *url.URL, field string) (string, error) {
	if parsed.User != nil || parsed.Host != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("%s unix socket URL must not include host, userinfo, query, or fragment", field)
	}
	if parsed.Path == "" || !strings.HasPrefix(parsed.Path, "/") {
		return "", fmt.Errorf("%s unix socket URL must use an absolute socket path", field)
	}
	if path.Clean(parsed.Path) != parsed.Path {
		return "", fmt.Errorf("%s unix socket URL path must be canonical", field)
	}
	if parsed.Path != AppRunnerUnixSocketPath {
		return "", fmt.Errorf("%s unix socket URL must use the dedicated app-runner socket path %s", field, AppRunnerUnixSocketPath)
	}
	return parsed.Path, nil
}
