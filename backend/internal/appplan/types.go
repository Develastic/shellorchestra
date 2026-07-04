// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package appplan

import (
	"fmt"
	"strings"
	"unicode"
)

const (
	OperationLaunch  = "launch"
	OperationInstall = "install"
	OperationData    = "data"
	OperationAction  = "action"
)

const (
	MaxMapFields      = 40
	MaxFactValueBytes = 4096
	MaxIdentityBytes  = 128
	MaxTokenBytes     = 64
	MaxMapKeyBytes    = 64
)

var allowedServerFactKeys = map[string]struct{}{
	"distro":          {},
	"package_manager": {},
	"platform":        {},
	"platform_arch":   {},
	"platform_os":     {},
	"shell":           {},
}

type Request struct {
	Version     int               `json:"version"`
	PluginID    string            `json:"plugin_id"`
	AppID       string            `json:"app_id"`
	Operation   string            `json:"operation"`
	Action      string            `json:"action,omitempty"`
	ServerID    string            `json:"server_id"`
	WindowID    string            `json:"window_id,omitempty"`
	ServerFacts map[string]string `json:"server_facts,omitempty"`
}

func ValidateRequest(request Request) error {
	if request.Version != 1 {
		return fmt.Errorf("unsupported app-runner request version")
	}
	if err := validateToken("plugin_id", request.PluginID, false); err != nil {
		return err
	}
	if err := validateToken("app_id", request.AppID, false); err != nil {
		return err
	}
	operation := request.Operation
	if operation != NormalizedOperation(operation) {
		return fmt.Errorf("operation contains unsupported characters")
	}
	switch operation {
	case OperationLaunch, OperationInstall, OperationData:
		if request.Action != "" {
			return fmt.Errorf("action is only supported for action operations")
		}
	case OperationAction:
		if err := validateToken("action", request.Action, false); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unsupported app operation %q", request.Operation)
	}
	if err := validateIdentity("server_id", request.ServerID, false); err != nil {
		return err
	}
	if err := validateIdentity("window_id", request.WindowID, true); err != nil {
		return err
	}
	if err := validateStringMap("server_facts", request.ServerFacts, MaxFactValueBytes); err != nil {
		return err
	}
	if err := validateServerFacts(request.ServerFacts); err != nil {
		return err
	}
	return nil
}

type Response struct {
	Version  int    `json:"version"`
	Kind     string `json:"kind"`
	ActionID string `json:"action_id"`
}

func ValidateResponse(response Response) error {
	if response.Version != 1 {
		return fmt.Errorf("unsupported app-runner response version")
	}
	if response.Kind != "action_request" {
		return fmt.Errorf("unsupported app-runner response kind")
	}
	if err := validateActionID(response.ActionID); err != nil {
		return err
	}
	return nil
}

func NormalizedOperation(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func NormalizedToken(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func ActionID(pluginID string, appID string, operation string, action string) string {
	if operation == OperationAction && action != "" {
		return pluginID + "." + appID + "." + action
	}
	return pluginID + "." + appID + "." + operation
}

func validateToken(label string, value string, optional bool) error {
	if strings.TrimSpace(value) != value {
		return fmt.Errorf("%s contains unsupported surrounding whitespace", label)
	}
	if value == "" {
		if optional {
			return nil
		}
		return fmt.Errorf("%s is required", label)
	}
	if len([]byte(value)) > MaxTokenBytes {
		return fmt.Errorf("%s is too long", label)
	}
	for index, item := range value {
		if index == 0 {
			if item < 'a' || item > 'z' {
				return fmt.Errorf("%s contains unsupported characters", label)
			}
			continue
		}
		if (item >= 'a' && item <= 'z') || (item >= '0' && item <= '9') || item == '_' {
			continue
		}
		return fmt.Errorf("%s contains unsupported characters", label)
	}
	return nil
}

func validateIdentity(label string, value string, optional bool) error {
	if strings.TrimSpace(value) != value {
		return fmt.Errorf("%s contains unsupported surrounding whitespace", label)
	}
	if value == "" {
		if optional {
			return nil
		}
		return fmt.Errorf("%s is required", label)
	}
	if len([]byte(value)) > MaxIdentityBytes {
		return fmt.Errorf("%s is too long", label)
	}
	for _, item := range value {
		if (item >= 'a' && item <= 'z') || (item >= 'A' && item <= 'Z') || (item >= '0' && item <= '9') || item == '_' || item == '-' {
			continue
		}
		return fmt.Errorf("%s contains unsupported characters", label)
	}
	return nil
}

func validateStringMap(label string, values map[string]string, maxValueBytes int) error {
	if len(values) > MaxMapFields {
		return fmt.Errorf("%s contains too many fields", label)
	}
	for rawKey, value := range values {
		key := strings.TrimSpace(rawKey)
		if key != rawKey {
			return fmt.Errorf("%s field %q contains unsupported surrounding whitespace", label, rawKey)
		}
		if err := validateMapKey(label, key); err != nil {
			return err
		}
		if len([]byte(value)) > maxValueBytes {
			return fmt.Errorf("%s field %q is too large", label, key)
		}
		if strings.ContainsRune(value, '\x00') {
			return fmt.Errorf("%s field %q contains a NUL byte", label, key)
		}
	}
	return nil
}

func validateServerFacts(values map[string]string) error {
	for rawKey, value := range values {
		key := rawKey
		if _, ok := allowedServerFactKeys[key]; !ok {
			return fmt.Errorf("server_facts field %q is not supported", rawKey)
		}
		if containsUnsafeControl(value) {
			return fmt.Errorf("server_facts field %q contains unsupported control characters", key)
		}
	}
	return nil
}

func validateActionID(value string) error {
	if strings.TrimSpace(value) != value {
		return fmt.Errorf("action_id contains unsupported surrounding whitespace")
	}
	if value == "" {
		return fmt.Errorf("action_id is required")
	}
	if len([]byte(value)) > MaxIdentityBytes {
		return fmt.Errorf("action_id is too long")
	}
	if containsUnsafeControl(value) {
		return fmt.Errorf("action_id contains unsupported control characters")
	}
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		return fmt.Errorf("action_id contains unsupported format")
	}
	for _, part := range parts {
		if err := validateToken("action_id", part, false); err != nil {
			return err
		}
	}
	return nil
}

func validateMapKey(label string, key string) error {
	if key == "" {
		return fmt.Errorf("%s contains an empty field name", label)
	}
	if len([]byte(key)) > MaxMapKeyBytes {
		return fmt.Errorf("%s field name is too long", label)
	}
	for index, item := range key {
		if index == 0 {
			if item < 'a' || item > 'z' {
				return fmt.Errorf("%s field %q contains unsupported characters", label, key)
			}
			continue
		}
		if (item >= 'a' && item <= 'z') || (item >= '0' && item <= '9') || item == '_' {
			continue
		}
		return fmt.Errorf("%s field %q contains unsupported characters", label, key)
	}
	return nil
}

func containsUnsafeControl(value string) bool {
	for _, item := range value {
		if unicode.IsControl(item) {
			return true
		}
	}
	return false
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
