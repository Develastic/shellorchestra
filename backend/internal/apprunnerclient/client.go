// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package apprunnerclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"shellorchestra/backend/internal/appplan"
	"shellorchestra/backend/internal/internaljson"
	"shellorchestra/backend/internal/internalurl"
)

type Client struct {
	endpoint       internalurl.ServiceEndpoint
	internalSecret string
	client         *http.Client
}

const (
	maxAppRunnerErrorBodyBytes        int64 = 64 << 10
	maxAppRunnerJSONResponseBodyBytes int64 = 1 << 20
)

func New(rawURL string, internalSecret string) (*Client, error) {
	endpoint, err := internalurl.ParseServiceOrUnixSocketURL(rawURL, "internal.app_runner_url")
	if err != nil {
		return nil, err
	}
	secret := strings.TrimSpace(internalSecret)
	if secret == "" {
		return nil, fmt.Errorf("internal.app_runner_shared_secret is required")
	}
	return &Client{endpoint: endpoint, internalSecret: secret, client: internalurl.HTTPClient(10*time.Second, endpoint.UnixSocketPath)}, nil
}

func (c *Client) Plan(ctx context.Context, request appplan.Request) (appplan.Response, error) {
	var response appplan.Response
	if err := appplan.ValidateRequest(request); err != nil {
		return response, err
	}
	err := c.do(ctx, http.MethodPost, "/internal/app-runner/plan", request, &response, 10*time.Second)
	if err == nil {
		err = appplan.ValidateResponse(response)
	}
	return response, err
}

func (c *Client) do(ctx context.Context, method string, path string, payload any, out any, timeout time.Duration) error {
	requestURL := c.endpoint.URL.ResolveReference(&url.URL{Path: path})
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
	client := *c.client
	client.Timeout = timeout
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var payload struct {
			Error string `json:"error"`
		}
		internaljson.DecodeBestEffort(resp.Body, maxAppRunnerErrorBodyBytes, &payload)
		if payload.Error == "" {
			payload.Error = resp.Status
		}
		return fmt.Errorf("%s", payload.Error)
	}
	if out == nil || resp.StatusCode == http.StatusNoContent {
		return nil
	}
	return internaljson.DecodeStrictResponse(resp.Body, maxAppRunnerJSONResponseBodyBytes, out, "app-runner response")
}
