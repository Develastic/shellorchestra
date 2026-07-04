// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package scripts

import (
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf16"
)

var scriptArgNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)

const maxScriptArgValueBytes = 256 * 1024

// Windows OpenSSH commonly starts cmd.exe as the default shell, and cmd.exe has
// a practical command-line ceiling near 8191 characters. Keep the inline budget
// just below that limit: short package previews avoid stdin bootstrap, while larger
// data scripts keep using the streaming stdin transport.
const maxPowerShellInlineCommandBytes = 8180
const shellOrchestraTerminalTerm = "xterm-256color"
const shellOrchestraTerminalColorTerm = "truecolor"
const shellOrchestraPowerShellRuntimeMarkerPrefix = "shellorchestra-runtime-"

// RemoteScriptExecution is the concrete transport plan for one target-side
// script run. Most shells can receive a single wrapped command; PowerShell app
// scripts can exceed the Windows command-line limit, so their source is carried
// through stdin behind a short bootstrap command.
type RemoteScriptExecution struct {
	Command      string
	Stdin        string
	StdinEnabled bool
}

// RemoteCommandForVariant returns the exact command that should be sent to the
// remote SSH session for a selected script variant. PowerShell scripts are
// encoded and launched through powershell.exe so they work even when Windows
// OpenSSH starts cmd.exe, bash, or another shell by default.
func RemoteCommandForVariant(selected SelectedScript) string {
	command := RemoteCommandForShell(selected.Body, selected.Variant.Shell)
	if !selected.Command.RequiresSudo {
		return command
	}
	return adminCommandForShell(command, selected.Variant.Shell)
}

// RemoteCommandForVariantWithArgs injects caller-provided data as
// ShellOrchestra-scoped environment variables before the selected script body.
// It is intended for data-oriented desktop applications where user input such
// as a path must be passed to an external script without templating shell code.
func RemoteCommandForVariantWithArgs(selected SelectedScript, args map[string]string) (string, error) {
	command, err := RemoteCommandForShellWithArgs(selected.Body, selected.Variant.Shell, args)
	if err != nil {
		return "", err
	}
	if !selected.Command.RequiresSudo {
		return command, nil
	}
	return adminCommandForShell(command, selected.Variant.Shell), nil
}

// RemoteExecutionForVariantWithArgs returns a command plus optional stdin body
// for script execution. Use this for backend-dispatched app scripts; it avoids
// Windows command-line length failures without moving script logic into Go.
func RemoteExecutionForVariantWithArgs(selected SelectedScript, args map[string]string) (RemoteScriptExecution, error) {
	execution, err := RemoteExecutionForShellWithArgs(selected.Body, selected.Variant.Shell, args)
	if err != nil {
		return RemoteScriptExecution{}, err
	}
	if !selected.Command.RequiresSudo {
		return execution, nil
	}
	return adminExecutionForShell(execution, selected.Variant.Shell), nil
}

// RemoteStreamCommandForVariantWithArgs returns a command for scripts that
// intentionally consume the SSH session stdin/stdout as binary data. Unlike
// RemoteCommandForVariantWithArgs, the POSIX wrapper does not use a here-doc,
// so the selected script can read the original stdin stream.
func RemoteStreamCommandForVariantWithArgs(selected SelectedScript, args map[string]string) (string, error) {
	command, err := RemoteStreamCommandForShellWithArgs(selected.Body, selected.Variant.Shell, args)
	if err != nil {
		return "", err
	}
	if !selected.Command.RequiresSudo {
		return command, nil
	}
	return adminCommandForShell(command, selected.Variant.Shell), nil
}

func adminExecutionForShell(execution RemoteScriptExecution, shell string) RemoteScriptExecution {
	switch normalizeShell(shell) {
	case "posix", "sh", "bash", "zsh":
		if execution.StdinEnabled && strings.TrimSpace(execution.Command) == "/bin/sh -s" {
			execution.Command = posixAdminStdinCommand()
			return execution
		}
		execution.Command = adminCommandForShell(execution.Command, shell)
		return execution
	default:
		return execution
	}
}

func adminCommandForShell(command string, shell string) string {
	switch normalizeShell(shell) {
	case "posix", "sh", "bash", "zsh":
		return posixAdminCommand(command)
	default:
		// Windows OpenSSH runs ShellOrchestra under the configured service
		// account. There is no safe non-interactive UAC elevation primitive here;
		// Windows admin capability is detected and reported separately.
		return command
	}
}

func posixAdminStdinCommand() string {
	return strings.Join([]string{
		"if [ \"$(id -u)\" -eq 0 ]; then",
		"  exec /bin/sh -s",
		"elif command -v sudo >/dev/null 2>&1; then",
		"  exec sudo -n /bin/sh -s",
		"elif command -v doas >/dev/null 2>&1; then",
		"  exec doas -n /bin/sh -s",
		"else",
		"  echo 'ShellOrchestra requires root, passwordless sudo, or passwordless doas for this operation.' >&2",
		"  exit 126",
		"fi",
	}, "\n")
}

func posixAdminCommand(command string) string {
	quoted := posixSingleQuotedString(command)
	return strings.Join([]string{
		"if [ \"$(id -u)\" -eq 0 ]; then",
		"  exec /bin/sh -c " + quoted,
		"elif command -v sudo >/dev/null 2>&1; then",
		"  exec sudo -n /bin/sh -c " + quoted,
		"elif command -v doas >/dev/null 2>&1; then",
		"  exec doas -n /bin/sh -c " + quoted,
		"else",
		"  echo 'ShellOrchestra requires root, passwordless sudo, or passwordless doas for this operation.' >&2",
		"  exit 126",
		"fi",
	}, "\n")
}

// RemoteCommandForShell wraps script bodies with the intended runtime.
// POSIX-compatible scripts are launched through /bin/sh instead of trusting the
// account's default shell: macOS often starts zsh, Windows OpenSSH may start
// cmd.exe, and shell-specific word-splitting rules can corrupt portable scripts.
func RemoteCommandForShell(body string, shell string) string {
	body = withTerminalEnvironment(body, shell)
	switch normalizeShell(shell) {
	case "powershell":
		return PowerShellEncodedCommand(body)
	case "posix", "sh", "bash", "zsh":
		return POSIXShellCommand(body)
	default:
		return body
	}
}

// POSIXShellCommand creates a here-doc launcher for portable shell scripts.
// The here-doc is parsed by the login shell, but the script body itself is
// executed by /bin/sh so zsh/bash defaults do not change POSIX semantics.
func POSIXShellCommand(body string) string {
	normalized := strings.ReplaceAll(body, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	delimiter := "SHELLORCHESTRA_POSIX_SCRIPT"
	for i := 2; containsHereDocDelimiter(normalized, delimiter); i++ {
		delimiter = fmt.Sprintf("SHELLORCHESTRA_POSIX_SCRIPT_%d", i)
	}
	return "/bin/sh <<'" + delimiter + "'\n" + strings.TrimRight(normalized, "\n") + "\n" + delimiter
}

func containsHereDocDelimiter(body string, delimiter string) bool {
	for _, line := range strings.Split(body, "\n") {
		if strings.TrimSpace(line) == delimiter {
			return true
		}
	}
	return false
}

// RemoteCommandForShellWithArgs is the argument-aware version of
// RemoteCommandForShell. Argument names become environment variables named
// SHELLORCHESTRA_<UPPER_NAME>. Values are quoted for the selected shell before
// the script is wrapped, so script bodies can read variables without string
// interpolation or command templating.
func RemoteCommandForShellWithArgs(body string, shell string, args map[string]string) (string, error) {
	prefix, err := scriptArgsPrefix(shell, args)
	if err != nil {
		return "", err
	}
	return RemoteCommandForShell(prefix+body, shell), nil
}

// RemoteExecutionForShellWithArgs is the stdin-aware execution planner. It is
// deliberately separate from RemoteCommandForShellWithArgs so copy/paste helper
// commands and existing tests keep their one-string behavior.
func RemoteExecutionForShellWithArgs(body string, shell string, args map[string]string) (RemoteScriptExecution, error) {
	prefix, err := scriptArgsPrefix(shell, args)
	if err != nil {
		return RemoteScriptExecution{}, err
	}
	script := prefix + body
	switch normalizeShell(shell) {
	case "posix", "sh", "bash", "zsh":
		return RemoteScriptExecution{
			Command:      "/bin/sh -s",
			Stdin:        strings.TrimRight(withTerminalEnvironment(script, shell), "\n"),
			StdinEnabled: true,
		}, nil
	}
	if hasSensitiveScriptArgs(args) {
		script = withTerminalEnvironment(script, shell)
		switch normalizeShell(shell) {
		case "powershell":
			return RemoteScriptExecution{
				Command:      PowerShellStdinCommand(),
				Stdin:        base64.StdEncoding.EncodeToString([]byte(script)),
				StdinEnabled: true,
			}, nil
		}
	}
	if normalizeShell(shell) == "powershell" {
		command := RemoteCommandForShell(script, shell)
		if len(command) <= maxPowerShellInlineCommandBytes {
			return RemoteScriptExecution{Command: command}, nil
		}
		stdinScript := withTerminalEnvironment(script, shell)
		return RemoteScriptExecution{
			Command:      PowerShellStdinCommand(),
			Stdin:        base64.StdEncoding.EncodeToString([]byte(stdinScript)),
			StdinEnabled: true,
		}, nil
	}
	return RemoteScriptExecution{Command: RemoteCommandForShell(script, shell)}, nil
}

func hasSensitiveScriptArgs(args map[string]string) bool {
	for key := range args {
		normalized := strings.ToLower(strings.TrimSpace(key))
		if strings.Contains(normalized, "password") || strings.Contains(normalized, "secret") || strings.Contains(normalized, "token") {
			return true
		}
	}
	return false
}

// RemoteStreamCommandForShellWithArgs preserves SSH stdin/stdout for binary
// file transfers. POSIX scripts are sent through `sh -c` instead of a here-doc;
// PowerShell scripts are encoded on the command line and can read raw stdin.
func RemoteStreamCommandForShellWithArgs(body string, shell string, args map[string]string) (string, error) {
	prefix, err := scriptArgsPrefix(shell, args)
	if err != nil {
		return "", err
	}
	script := withTerminalEnvironment(prefix+body, shell)
	switch normalizeShell(shell) {
	case "powershell":
		return PowerShellEncodedCommand(script), nil
	case "posix", "sh", "bash", "zsh":
		normalized := strings.ReplaceAll(script, "\r\n", "\n")
		normalized = strings.ReplaceAll(normalized, "\r", "\n")
		return "/bin/sh -c " + posixSingleQuotedString(strings.TrimRight(normalized, "\n")), nil
	default:
		return script, nil
	}
}

func scriptArgsPrefix(shell string, args map[string]string) (string, error) {
	if len(args) == 0 {
		return "", nil
	}
	keys := make([]string, 0, len(args))
	for key := range args {
		key = strings.TrimSpace(key)
		if !scriptArgNamePattern.MatchString(key) {
			return "", fmt.Errorf("script argument %q has an unsupported name", key)
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var builder strings.Builder
	if normalizeShell(shell) == "powershell" {
		for _, key := range keys {
			value := args[key]
			if len(value) > maxScriptArgValueBytes {
				return "", fmt.Errorf("script argument %q is too long", key)
			}
			if strings.ContainsRune(value, '\x00') {
				return "", fmt.Errorf("script argument %q contains a NUL byte", key)
			}
			builder.WriteString("$env:SHELLORCHESTRA_")
			builder.WriteString(strings.ToUpper(key))
			builder.WriteString(" = ")
			builder.WriteString(powerShellSingleQuotedString(value))
			builder.WriteByte('\n')
		}
		return builder.String(), nil
	}
	for _, key := range keys {
		value := args[key]
		if len(value) > maxScriptArgValueBytes {
			return "", fmt.Errorf("script argument %q is too long", key)
		}
		if strings.ContainsRune(value, '\x00') {
			return "", fmt.Errorf("script argument %q contains a NUL byte", key)
		}
		builder.WriteString("SHELLORCHESTRA_")
		builder.WriteString(strings.ToUpper(key))
		builder.WriteByte('=')
		builder.WriteString(posixSingleQuotedString(value))
		builder.WriteByte('\n')
	}
	return builder.String(), nil
}

func withTerminalEnvironment(body string, shell string) string {
	switch normalizeShell(shell) {
	case "powershell":
		return "$env:TERM = " + powerShellSingleQuotedString(shellOrchestraTerminalTerm) + "\n" +
			"$env:COLORTERM = " + powerShellSingleQuotedString(shellOrchestraTerminalColorTerm) + "\n" +
			body
	case "posix", "sh", "bash", "zsh":
		return "export TERM=" + posixSingleQuotedString(shellOrchestraTerminalTerm) + "\n" +
			"export COLORTERM=" + posixSingleQuotedString(shellOrchestraTerminalColorTerm) + "\n" +
			body
	default:
		return body
	}
}

// PowerShellEncodedCommand creates a Windows PowerShell launcher command for a
// UTF-16LE encoded script body.
func PowerShellEncodedCommand(script string) string {
	markerPrelude := powerShellRuntimeMarkerPrelude()
	if compressed, err := compressedPowerShellScript(script); err == nil {
		stub := markerPrelude +
			"$b=[Convert]::FromBase64String('" + compressed + "');" +
			"$m=New-Object System.IO.MemoryStream(,$b);" +
			"$g=New-Object System.IO.Compression.GzipStream($m,[System.IO.Compression.CompressionMode]::Decompress);" +
			"$r=New-Object System.IO.StreamReader($g,[System.Text.Encoding]::UTF8);" +
			"$s=$r.ReadToEnd();" +
			"& ([scriptblock]::Create($s))"
		return powerShellEncodedCommand(stub)
	}
	return powerShellEncodedCommand(markerPrelude + script)
}

func PowerShellStdinCommand() string {
	stub := powerShellRuntimeMarkerPrelude() +
		"[Console]::InputEncoding=[System.Text.Encoding]::UTF8;" +
		"$env:TERM='xterm-256color';" +
		"$env:COLORTERM='truecolor';" +
		"$p=[Console]::In.ReadToEnd();" +
		"$b=[Convert]::FromBase64String($p);" +
		"$s=[System.Text.Encoding]::UTF8.GetString($b);" +
		"& ([scriptblock]::Create($s))"
	return powerShellEncodedCommand(stub)
}

func powerShellEncodedCommand(script string) string {
	encoded := utf16.Encode([]rune(script))
	data := make([]byte, 0, len(encoded)*2)
	for _, value := range encoded {
		data = append(data, byte(value), byte(value>>8))
	}
	return "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + base64.StdEncoding.EncodeToString(data)
}

func powerShellRuntimeMarkerPrelude() string {
	return "$ProgressPreference='SilentlyContinue'\n" +
		"$VerbosePreference='SilentlyContinue'\n" +
		"$InformationPreference='SilentlyContinue'\n" +
		"$env:SHELLORCHESTRA_RUNTIME_MARKER = " + powerShellSingleQuotedString(newPowerShellRuntimeMarker()) + "\n"
}

func newPowerShellRuntimeMarker() string {
	randomBytes := make([]byte, 16)
	if _, err := rand.Read(randomBytes); err == nil {
		return shellOrchestraPowerShellRuntimeMarkerPrefix + hex.EncodeToString(randomBytes)
	}
	return fmt.Sprintf("%s%d", shellOrchestraPowerShellRuntimeMarkerPrefix, time.Now().UnixNano())
}

func compressedPowerShellScript(script string) (string, error) {
	var buffer bytes.Buffer
	writer, err := gzip.NewWriterLevel(&buffer, gzip.BestCompression)
	if err != nil {
		return "", err
	}
	if _, err := writer.Write([]byte(script)); err != nil {
		_ = writer.Close()
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(buffer.Bytes()), nil
}

func posixSingleQuotedString(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func powerShellSingleQuotedString(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

// ShellLooksLikePowerShell reports whether a shell label should be treated as
// PowerShell for remote execution purposes.
func ShellLooksLikePowerShell(shell string) bool {
	return normalizeShell(strings.TrimSpace(shell)) == "powershell"
}
