// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package sshconfig

import (
	"fmt"
	"strconv"
	"strings"
)

type Profile struct {
	Name            string
	Host            string
	Username        string
	Port            int
	IdentityFiles   []string
	IdentityAgent   string
	ProxyJump       string
	ProxyCommand    string
	Line            int
	UsedDefaultUser bool
}

type Issue struct {
	Line   int    `json:"line"`
	Host   string `json:"host,omitempty"`
	Reason string `json:"reason"`
}

type optionValue struct {
	value string
	line  int
}

type hostBlock struct {
	patterns []string
	options  map[string][]optionValue
	line     int
}

func Parse(data string, defaultUsername string) ([]Profile, []Issue) {
	defaultUsername = strings.TrimSpace(defaultUsername)
	var profiles []Profile
	var issues []Issue
	globalOptions := map[string][]optionValue{}
	current := hostBlock{options: map[string][]optionValue{}}
	seenNames := map[string]struct{}{}

	flush := func() {
		if len(current.patterns) == 0 {
			return
		}
		blockProfiles, blockIssues := buildProfiles(current, globalOptions, defaultUsername, seenNames)
		profiles = append(profiles, blockProfiles...)
		issues = append(issues, blockIssues...)
		for _, profile := range blockProfiles {
			seenNames[profile.Name] = struct{}{}
		}
	}

	lines := strings.Split(strings.ReplaceAll(data, "\r\n", "\n"), "\n")
	for index, rawLine := range lines {
		lineNumber := index + 1
		fields := splitConfigLine(rawLine)
		if len(fields) == 0 {
			continue
		}
		keyword, values := splitDirective(fields)
		keyword = strings.ToLower(keyword)
		if keyword == "" || len(values) == 0 {
			continue
		}
		if keyword == "host" {
			flush()
			current = hostBlock{patterns: values, options: map[string][]optionValue{}, line: lineNumber}
			continue
		}
		value := strings.TrimSpace(strings.Join(values, " "))
		if value == "" {
			continue
		}
		if len(current.patterns) == 0 {
			globalOptions[keyword] = append(globalOptions[keyword], optionValue{value: value, line: lineNumber})
			continue
		}
		current.options[keyword] = append(current.options[keyword], optionValue{value: value, line: lineNumber})
	}
	flush()
	return profiles, issues
}

func buildProfiles(block hostBlock, globalOptions map[string][]optionValue, defaultUsername string, seenNames map[string]struct{}) ([]Profile, []Issue) {
	var profiles []Profile
	var issues []Issue
	for _, pattern := range block.patterns {
		name := strings.TrimSpace(pattern)
		if name == "" {
			continue
		}
		if isPattern(name) {
			issues = append(issues, Issue{Line: block.line, Host: name, Reason: "host pattern is not a concrete profile"})
			continue
		}
		if _, exists := seenNames[name]; exists {
			issues = append(issues, Issue{Line: block.line, Host: name, Reason: "duplicate host profile name"})
			continue
		}
		if len(name) > 120 {
			issues = append(issues, Issue{Line: block.line, Host: name, Reason: "host profile name is longer than 120 characters"})
			continue
		}
		host := optionFirst(block.options, globalOptions, "hostname")
		if host.value == "" {
			host.value = name
		}
		if strings.Contains(host.value, "%") {
			issues = append(issues, Issue{Line: valueLine(host, block.line), Host: name, Reason: "HostName contains SSH runtime tokens that cannot be imported safely"})
			continue
		}
		username := optionFirst(block.options, globalOptions, "user")
		usedDefaultUser := false
		if username.value == "" {
			username.value = defaultUsername
			usedDefaultUser = username.value != ""
		}
		if strings.TrimSpace(username.value) == "" {
			issues = append(issues, Issue{Line: block.line, Host: name, Reason: "User is required; set User in SSH config or default username in the import form"})
			continue
		}
		port := 22
		portOption := optionFirst(block.options, globalOptions, "port")
		if portOption.value != "" {
			parsed, err := strconv.Atoi(portOption.value)
			if err != nil || parsed < 1 || parsed > 65535 {
				issues = append(issues, Issue{Line: valueLine(portOption, block.line), Host: name, Reason: fmt.Sprintf("invalid Port %q", portOption.value)})
				continue
			}
			port = parsed
		}
		seenNames[name] = struct{}{}
		profiles = append(profiles, Profile{
			Name:            name,
			Host:            host.value,
			Username:        username.value,
			Port:            port,
			IdentityFiles:   optionValues(block.options, globalOptions, "identityfile"),
			IdentityAgent:   optionFirst(block.options, globalOptions, "identityagent").value,
			ProxyJump:       optionFirst(block.options, globalOptions, "proxyjump").value,
			ProxyCommand:    optionFirst(block.options, globalOptions, "proxycommand").value,
			Line:            block.line,
			UsedDefaultUser: usedDefaultUser,
		})
	}
	return profiles, issues
}

func optionFirst(local map[string][]optionValue, global map[string][]optionValue, key string) optionValue {
	if values := local[key]; len(values) > 0 {
		return values[0]
	}
	if values := global[key]; len(values) > 0 {
		return values[0]
	}
	return optionValue{}
}

func optionValues(local map[string][]optionValue, global map[string][]optionValue, key string) []string {
	values := local[key]
	if len(values) == 0 {
		values = global[key]
	}
	result := make([]string, 0, len(values))
	for _, item := range values {
		if strings.TrimSpace(item.value) != "" {
			result = append(result, item.value)
		}
	}
	return result
}

func valueLine(value optionValue, fallback int) int {
	if value.line > 0 {
		return value.line
	}
	return fallback
}

func isPattern(host string) bool {
	return strings.ContainsAny(host, "*?!")
}

func splitDirective(fields []string) (string, []string) {
	first := fields[0]
	if key, value, ok := strings.Cut(first, "="); ok {
		values := []string{}
		if value != "" {
			values = append(values, value)
		}
		values = append(values, fields[1:]...)
		return key, values
	}
	if len(fields) > 1 && fields[1] == "=" {
		return first, fields[2:]
	}
	return first, fields[1:]
}

func splitConfigLine(line string) []string {
	line = stripComment(line)
	var fields []string
	var current strings.Builder
	var quote rune
	escaped := false
	flush := func() {
		if current.Len() == 0 {
			return
		}
		fields = append(fields, current.String())
		current.Reset()
	}
	for _, ch := range line {
		if escaped {
			current.WriteRune(ch)
			escaped = false
			continue
		}
		if ch == '\\' {
			escaped = true
			continue
		}
		if quote != 0 {
			if ch == quote {
				quote = 0
				continue
			}
			current.WriteRune(ch)
			continue
		}
		if ch == '\'' || ch == '"' {
			quote = ch
			continue
		}
		if ch == '=' {
			flush()
			fields = append(fields, "=")
			continue
		}
		if ch == ' ' || ch == '\t' {
			flush()
			continue
		}
		current.WriteRune(ch)
	}
	flush()
	return fields
}

func stripComment(line string) string {
	var result strings.Builder
	var quote rune
	escaped := false
	for _, ch := range line {
		if escaped {
			result.WriteRune(ch)
			escaped = false
			continue
		}
		if ch == '\\' {
			escaped = true
			result.WriteRune(ch)
			continue
		}
		if quote != 0 {
			if ch == quote {
				quote = 0
			}
			result.WriteRune(ch)
			continue
		}
		if ch == '\'' || ch == '"' {
			quote = ch
			result.WriteRune(ch)
			continue
		}
		if ch == '#' {
			break
		}
		result.WriteRune(ch)
	}
	return result.String()
}
