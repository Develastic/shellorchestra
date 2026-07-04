// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

//go:build windows

package sshconfig

import (
	"encoding/xml"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const maxNativeSourceFileBytes int64 = 16 * 1024 * 1024

func appendPlatformProfileSources(result *SourceScanResult, defaultUsername string) {
	appendRegistrySSHSource(result, "putty", "PuTTY", []string{`Software\SimonTatham\PuTTY\Sessions`}, defaultUsername)
	appendRegistrySSHSource(result, "kitty", "KiTTY", []string{`Software\9bis.com\KiTTY\Sessions`, `Software\KiTTY\Sessions`}, defaultUsername)
	appendFileTreeSSHSource(result, "kitty_portable", "KiTTY portable", knownKiTTYSessionRoots(), []string{""}, parsePuTTYStyleSessionFile, defaultUsername)
	appendRegistrySSHSource(result, "winscp", "WinSCP", []string{`Software\Martin Prikryl\WinSCP 2\Sessions`}, defaultUsername)
	appendFileSSHSource(result, "winscp_ini", "WinSCP INI", knownWinSCPINIPaths(), parseWinSCPINI, defaultUsername)
	appendFileSSHSource(result, "mobaxterm", "MobaXterm", knownMobaXtermINIPaths(), parseMobaXtermINI, defaultUsername)
	appendFileSSHSource(result, "mremoteng", "mRemoteNG", knownMRemoteNGPaths(), parseMRemoteNGXML, defaultUsername)
	appendFileTreeSSHSource(result, "securecrt", "SecureCRT", knownSecureCRTRoots(), []string{".ini"}, parseSecureCRTSessionFile, defaultUsername)
	appendFileTreeSSHSource(result, "xshell", "Xshell", knownXshellRoots(), []string{".xsh"}, parseXshellSessionFile, defaultUsername)
	appendFileTreeSSHSource(result, "bitvise", "Bitvise SSH Client", knownBitviseRoots(), []string{".tlp", ".bscp"}, parseGenericSSHProfileFile, defaultUsername)
	appendFileTreeSSHSource(result, "royalts", "Royal TS", knownRoyalTSRoots(), []string{".rtsx", ".xml"}, parseGenericXMLSSHProfiles, defaultUsername)
	appendFileTreeSSHSource(result, "rdm", "Remote Desktop Manager", knownRDMRoots(), []string{".rdm", ".xml", ".json"}, parseGenericExportedSSHProfiles, defaultUsername)
	appendFileTreeSSHSource(result, "termius_export", "Termius export", knownTermiusExportRoots(), []string{".json"}, parseGenericExportedSSHProfiles, defaultUsername)
}

func appendRegistrySSHSource(result *SourceScanResult, id string, label string, registryPaths []string, defaultUsername string) {
	foundAny := false
	count := 0
	var details []string
	var sourceWarnings []string
	for _, registryPath := range registryPaths {
		key, err := registry.OpenKey(registry.CURRENT_USER, registryPath, registry.READ)
		if err != nil {
			continue
		}
		foundAny = true
		details = append(details, `HKCU\`+registryPath)
		names, err := key.ReadSubKeyNames(-1)
		key.Close()
		if err != nil {
			result.Sources = append(result.Sources, SourceScanSource{ID: id, Label: label, State: "error", UnsupportedReason: "ShellOrchestra could not enumerate this application's saved sessions.", Detail: `HKCU\` + registryPath})
			return
		}
		for _, rawName := range names {
			profile, warnings, ok := registrySessionProfile(id, registryPath, rawName, defaultUsername)
			if !ok {
				continue
			}
			count++
			result.Profiles = append(result.Profiles, sourceProfileFromSSHConfig(id, profile, authSuggestionForProfile(profile), warnings))
		}
	}
	if !foundAny {
		result.Sources = append(result.Sources, SourceScanSource{ID: id, Label: label, State: "not_found"})
		return
	}
	state := "found"
	if count == 0 {
		state = "empty"
	}
	if count > 0 {
		sourceWarnings = append(sourceWarnings, "Saved passwords are ignored. Imported profiles still require key/certificate authentication.")
	}
	result.Sources = append(result.Sources, SourceScanSource{ID: id, Label: label, State: state, ProfileCount: count, UnsupportedReason: strings.Join(sourceWarnings, " "), Detail: strings.Join(details, "; ")})
}

func registrySessionProfile(sourceID string, parentPath string, rawName string, defaultUsername string) (Profile, []string, bool) {
	key, err := registry.OpenKey(registry.CURRENT_USER, parentPath+`\`+rawName, registry.READ)
	if err != nil {
		return Profile{}, nil, false
	}
	defer key.Close()
	protocol := strings.ToLower(firstNonEmpty(regString(key, "Protocol"), regString(key, "FSProtocol"), regString(key, "SessionType")))
	if sourceID == "putty" || sourceID == "kitty" {
		if protocol != "" && protocol != "ssh" {
			return Profile{}, nil, false
		}
	}
	host := firstNonEmpty(regString(key, "HostName"), regString(key, "Host"), regString(key, "HostName2"))
	if strings.TrimSpace(host) == "" {
		return Profile{}, nil, false
	}
	user := firstNonEmpty(regString(key, "UserName"), regString(key, "User"), defaultUsername)
	parsedUser, parsedHost, parsedPort := splitUserHostPort(host)
	if parsedHost != "" {
		host = parsedHost
	}
	if user == "" {
		user = parsedUser
	}
	if user == "" {
		return Profile{}, []string{"User was not saved in the source profile and no default import username was provided."}, false
	}
	port := firstValidPort(22, parsedPort, regInt(key, "PortNumber", 0), regInt(key, "Port", 0))
	identity := firstNonEmpty(regString(key, "PublicKeyFile"), regString(key, "IdentityFile"), regString(key, "PrivateKeyFile"), regString(key, "TunnelPrivateKeyFile"))
	name := decodeRegistrySessionName(rawName)
	profile, warnings, ok := nativeProfile(name, host, user, port, []string{identity}, defaultUsername)
	if !ok {
		return Profile{}, warnings, false
	}
	if identity == "" {
		warnings = append(warnings, "No key path was saved in the source profile; ShellOrchestra will default to its SSH CA unless another auth method is selected.")
	}
	return profile, warnings, true
}

func appendFileSSHSource(result *SourceScanResult, id string, label string, paths []string, parser sourceFileParser, defaultUsername string) {
	foundAny := false
	count := 0
	var details []string
	var sourceWarnings []string
	for _, path := range cleanPathList(paths) {
		if !regularFileWithinLimit(path) {
			continue
		}
		foundAny = true
		details = append(details, path)
		profiles, warnings, err := parser(path, id, defaultUsername)
		if err != nil {
			result.Sources = append(result.Sources, SourceScanSource{ID: id, Label: label, State: "error", UnsupportedReason: err.Error(), Detail: path})
			return
		}
		count += len(profiles)
		sourceWarnings = append(sourceWarnings, warnings...)
		for _, profile := range profiles {
			result.Profiles = append(result.Profiles, sourceProfileFromSSHConfig(id, profile, authSuggestionForProfile(profile), nil))
		}
	}
	if !foundAny {
		result.Sources = append(result.Sources, SourceScanSource{ID: id, Label: label, State: "not_found"})
		return
	}
	state := "found"
	if count == 0 {
		state = "empty"
	}
	result.Sources = append(result.Sources, SourceScanSource{ID: id, Label: label, State: state, ProfileCount: count, UnsupportedReason: dedupeJoin(sourceWarnings), Detail: strings.Join(details, "; ")})
}

func appendFileTreeSSHSource(result *SourceScanResult, id string, label string, roots []string, extensions []string, parser sourceFileParser, defaultUsername string) {
	roots = cleanPathList(roots)
	if len(roots) == 0 {
		result.Sources = append(result.Sources, SourceScanSource{ID: id, Label: label, State: "not_found"})
		return
	}
	foundAny := false
	count := 0
	var details []string
	var sourceWarnings []string
	remainingFiles := 500
	for _, root := range roots {
		if stat, err := os.Stat(root); err != nil || !stat.IsDir() {
			continue
		}
		foundAny = true
		details = append(details, root)
		_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil || remainingFiles <= 0 {
				return nil
			}
			if entry.IsDir() {
				return nil
			}
			if !extensionAllowed(path, extensions) || !regularFileWithinLimit(path) {
				return nil
			}
			remainingFiles--
			profiles, warnings, parseErr := parser(path, id, defaultUsername)
			if parseErr != nil {
				sourceWarnings = append(sourceWarnings, fmt.Sprintf("%s: %s", filepath.Base(path), parseErr.Error()))
				return nil
			}
			count += len(profiles)
			sourceWarnings = append(sourceWarnings, warnings...)
			for _, profile := range profiles {
				result.Profiles = append(result.Profiles, sourceProfileFromSSHConfig(id, profile, authSuggestionForProfile(profile), nil))
			}
			return nil
		})
	}
	if !foundAny {
		result.Sources = append(result.Sources, SourceScanSource{ID: id, Label: label, State: "not_found"})
		return
	}
	state := "found"
	if count == 0 {
		state = "empty"
	}
	if remainingFiles <= 0 {
		sourceWarnings = append(sourceWarnings, "Scan stopped after 500 files to keep the import preview responsive. Export selected profiles from the source application if more entries are needed.")
	}
	result.Sources = append(result.Sources, SourceScanSource{ID: id, Label: label, State: state, ProfileCount: count, UnsupportedReason: dedupeJoin(sourceWarnings), Detail: strings.Join(details, "; ")})
}

type sourceFileParser func(path string, sourceID string, defaultUsername string) ([]Profile, []string, error)

func parsePuTTYStyleSessionFile(path string, sourceID string, defaultUsername string) ([]Profile, []string, error) {
	values, err := parseKeyValueFile(path)
	if err != nil {
		return nil, nil, err
	}
	host := kvFirst(values, "hostname", "host")
	if host == "" {
		return nil, nil, nil
	}
	user := kvFirst(values, "username", "user")
	port := parsePort(kvFirst(values, "portnumber", "port"), 22)
	identity := kvFirst(values, "publickeyfile", "identityfile", "privatekeyfile")
	profile, warnings, ok := nativeProfile(strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)), host, user, port, []string{identity}, defaultUsername)
	if !ok {
		return nil, warnings, nil
	}
	return []Profile{profile}, warnings, nil
}

func parseWinSCPINI(path string, sourceID string, defaultUsername string) ([]Profile, []string, error) {
	sections, err := parseINIFile(path)
	if err != nil {
		return nil, nil, err
	}
	var profiles []Profile
	var warnings []string
	for section, values := range sections {
		sectionLower := strings.ToLower(section)
		if !strings.Contains(sectionLower, "session") {
			continue
		}
		host := kvFirst(values, "hostname", "host")
		if host == "" {
			continue
		}
		name := sectionNameTail(section)
		user := kvFirst(values, "username", "user")
		port := parsePort(kvFirst(values, "portnumber", "port"), 22)
		identity := kvFirst(values, "publickeyfile", "privatekeyfile", "identityfile")
		profile, itemWarnings, ok := nativeProfile(name, host, user, port, []string{identity}, defaultUsername)
		warnings = append(warnings, itemWarnings...)
		if ok {
			profiles = append(profiles, profile)
		}
	}
	return profiles, warnings, nil
}

func parseMobaXtermINI(path string, sourceID string, defaultUsername string) ([]Profile, []string, error) {
	sections, err := parseINIFile(path)
	if err != nil {
		return nil, nil, err
	}
	var profiles []Profile
	var warnings []string
	for section, values := range sections {
		sectionLower := strings.ToLower(section)
		if !strings.Contains(sectionLower, "bookmark") && !strings.Contains(sectionLower, "session") {
			continue
		}
		for rawName, rawValue := range values {
			if !looksLikeSSHSessionText(rawValue) && !looksLikeSSHSessionText(rawName) {
				continue
			}
			profile, itemWarnings, ok := profileFromSessionText(rawName, rawValue, defaultUsername)
			warnings = append(warnings, itemWarnings...)
			if ok {
				profile.Name = firstNonEmpty(profile.Name, rawName)
				profiles = append(profiles, profile)
			}
		}
	}
	return profiles, warnings, nil
}

func parseMRemoteNGXML(path string, sourceID string, defaultUsername string) ([]Profile, []string, error) {
	return parseXMLAttributes(path, defaultUsername, func(name string, attrs map[string]string) bool {
		protocol := strings.ToLower(firstNonEmpty(attrs["protocol"], attrs["type"]))
		return strings.Contains(protocol, "ssh") || strings.Contains(protocol, "sftp") || attrs["puttysession"] != ""
	})
}

func parseSecureCRTSessionFile(path string, sourceID string, defaultUsername string) ([]Profile, []string, error) {
	values, err := parseVanDykeINI(path)
	if err != nil {
		return nil, nil, err
	}
	protocol := strings.ToLower(kvFirst(values, "protocol name", "protocol"))
	if protocol != "" && !strings.Contains(protocol, "ssh") {
		return nil, nil, nil
	}
	host := kvFirst(values, "hostname", "host")
	if host == "" {
		return nil, nil, nil
	}
	user := kvFirst(values, "username", "user")
	port := parsePort(kvFirst(values, "port", "ssh2 port"), 22)
	identity := kvFirst(values, "identity filename", "publickeyfile", "identityfile")
	name := sessionNameFromPath(path, "Sessions")
	profile, warnings, ok := nativeProfile(name, host, user, port, []string{identity}, defaultUsername)
	if !ok {
		return nil, warnings, nil
	}
	return []Profile{profile}, warnings, nil
}

func parseXshellSessionFile(path string, sourceID string, defaultUsername string) ([]Profile, []string, error) {
	values, err := parseKeyValueFile(path)
	if err != nil {
		return nil, nil, err
	}
	host := kvFirst(values, "host", "hostname")
	if host == "" {
		return nil, nil, nil
	}
	user := kvFirst(values, "username", "user", "loginuser")
	port := parsePort(kvFirst(values, "port"), 22)
	identity := kvFirst(values, "identityfile", "privatekeyfile", "keyfile")
	profile, warnings, ok := nativeProfile(strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)), host, user, port, []string{identity}, defaultUsername)
	if !ok {
		return nil, warnings, nil
	}
	return []Profile{profile}, warnings, nil
}

func parseGenericSSHProfileFile(path string, sourceID string, defaultUsername string) ([]Profile, []string, error) {
	values, err := parseKeyValueFile(path)
	if err != nil {
		return nil, nil, err
	}
	host := kvFirst(values, "host", "hostname", "serverhost", "address", "computername")
	if host == "" {
		return nil, nil, nil
	}
	user := kvFirst(values, "username", "user", "login", "loginname")
	port := parsePort(kvFirst(values, "port", "serverport"), 22)
	identity := kvFirst(values, "identityfile", "keyfile", "privatekeyfile", "publickeyfile")
	name := firstNonEmpty(kvFirst(values, "name", "sessionname", "displayname"), strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)))
	profile, warnings, ok := nativeProfile(name, host, user, port, []string{identity}, defaultUsername)
	if !ok {
		return nil, warnings, nil
	}
	return []Profile{profile}, warnings, nil
}

func parseGenericXMLSSHProfiles(path string, sourceID string, defaultUsername string) ([]Profile, []string, error) {
	return parseXMLAttributes(path, defaultUsername, func(name string, attrs map[string]string) bool {
		text := strings.ToLower(name + " " + attrs["type"] + " " + attrs["protocol"] + " " + attrs["connectiontype"] + " " + attrs["objecttype"])
		return strings.Contains(text, "ssh") || strings.Contains(text, "sftp") || strings.Contains(text, "terminal")
	})
}

func parseGenericExportedSSHProfiles(path string, sourceID string, defaultUsername string) ([]Profile, []string, error) {
	ext := strings.ToLower(filepath.Ext(path))
	if ext == ".xml" || ext == ".rdm" || ext == ".rtsx" {
		return parseGenericXMLSSHProfiles(path, sourceID, defaultUsername)
	}
	content, err := readSmallTextFile(path)
	if err != nil {
		return nil, nil, err
	}
	var profiles []Profile
	var warnings []string
	for _, object := range strings.Split(content, "{") {
		if !looksLikeSSHSessionText(object) {
			continue
		}
		profile, itemWarnings, ok := profileFromSessionText(strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)), object, defaultUsername)
		warnings = append(warnings, itemWarnings...)
		if ok {
			profiles = append(profiles, profile)
		}
	}
	return profiles, warnings, nil
}

func parseXMLAttributes(path string, defaultUsername string, accept func(name string, attrs map[string]string) bool) ([]Profile, []string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
	decoder := xml.NewDecoder(file)
	var profiles []Profile
	var warnings []string
	for {
		token, err := decoder.Token()
		if err != nil {
			break
		}
		start, ok := token.(xml.StartElement)
		if !ok {
			continue
		}
		attrs := map[string]string{}
		for _, attr := range start.Attr {
			attrs[strings.ToLower(attr.Name.Local)] = strings.TrimSpace(attr.Value)
		}
		if !accept(start.Name.Local, attrs) {
			continue
		}
		host := firstNonEmpty(attrs["hostname"], attrs["host"], attrs["address"], attrs["computername"], attrs["url"], attrs["uri"])
		if host == "" {
			continue
		}
		user := firstNonEmpty(attrs["username"], attrs["user"], attrs["login"], attrs["loginname"])
		name := firstNonEmpty(attrs["name"], attrs["displayname"], attrs["title"], host)
		port := parsePort(firstNonEmpty(attrs["port"], attrs["sshport"]), 22)
		identity := firstNonEmpty(attrs["identityfile"], attrs["keyfile"], attrs["privatekeyfile"], attrs["publickeyfile"])
		profile, itemWarnings, ok := nativeProfile(name, host, user, port, []string{identity}, defaultUsername)
		warnings = append(warnings, itemWarnings...)
		if ok {
			profiles = append(profiles, profile)
		}
	}
	return profiles, warnings, nil
}

func nativeProfile(name string, host string, user string, port int, identityFiles []string, defaultUsername string) (Profile, []string, bool) {
	parsedUser, parsedHost, parsedPort := splitUserHostPort(host)
	if parsedHost != "" {
		host = parsedHost
	}
	if user == "" {
		user = parsedUser
	}
	if user == "" {
		user = defaultUsername
	}
	warnings := []string{}
	if strings.TrimSpace(user) == "" {
		warnings = append(warnings, "User was not saved in the source profile and no default import username was provided.")
		return Profile{}, warnings, false
	}
	port = firstValidPort(22, parsedPort, port)
	identityFiles = cleanPathList(identityFiles)
	return Profile{Name: sanitizeProfileName(firstNonEmpty(name, host)), Host: cleanImportedScalar(host), Username: cleanImportedScalar(user), Port: port, IdentityFiles: identityFiles}, warnings, true
}

func profileFromSessionText(name string, text string, defaultUsername string) (Profile, []string, bool) {
	if parsedURL, ok := parseFirstSSHURL(text); ok {
		return nativeProfile(name, parsedURL.host, parsedURL.user, parsedURL.port, nil, defaultUsername)
	}
	values := looseKeyValues(text)
	host := kvFirst(values, "hostname", "host", "remotehost", "server", "address", "computername")
	user := kvFirst(values, "username", "user", "login", "loginname")
	port := parsePort(kvFirst(values, "port", "sshport"), 22)
	identity := kvFirst(values, "identityfile", "keyfile", "privatekeyfile", "publickeyfile")
	if host == "" {
		host, user, port = guessHostUserPortFromTokens(text)
	}
	if host == "" {
		return Profile{}, nil, false
	}
	return nativeProfile(name, host, user, port, []string{identity}, defaultUsername)
}

type parsedSSHURL struct {
	host string
	user string
	port int
}

func parseFirstSSHURL(text string) (parsedSSHURL, bool) {
	lower := strings.ToLower(text)
	index := strings.Index(lower, "ssh://")
	if index < 0 {
		return parsedSSHURL{}, false
	}
	candidate := text[index:]
	for end, ch := range candidate {
		if ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n' || ch == '"' || ch == '\'' || ch == ',' || ch == ';' || ch == ')' || ch == ']' {
			candidate = candidate[:end]
			break
		}
	}
	parsed, err := url.Parse(candidate)
	if err != nil || parsed.Hostname() == "" {
		return parsedSSHURL{}, false
	}
	port := parsePort(parsed.Port(), 22)
	user := ""
	if parsed.User != nil {
		user = parsed.User.Username()
	}
	return parsedSSHURL{host: parsed.Hostname(), user: user, port: port}, true
}

func parseKeyValueFile(path string) (map[string]string, error) {
	content, err := readSmallTextFile(path)
	if err != nil {
		return nil, err
	}
	values := map[string]string{}
	for _, rawLine := range strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		key, value, ok := splitLooseKeyValue(line)
		if !ok {
			continue
		}
		values[strings.ToLower(key)] = cleanImportedScalar(value)
	}
	return values, nil
}

func parseINIFile(path string) (map[string]map[string]string, error) {
	content, err := readSmallTextFile(path)
	if err != nil {
		return nil, err
	}
	sections := map[string]map[string]string{"": {}}
	current := ""
	for _, rawLine := range strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.Contains(line, "]") {
			current = strings.TrimSpace(line[1:strings.Index(line, "]")])
			if sections[current] == nil {
				sections[current] = map[string]string{}
			}
			continue
		}
		key, value, ok := splitLooseKeyValue(line)
		if !ok {
			continue
		}
		sections[current][strings.ToLower(key)] = cleanImportedScalar(value)
	}
	return sections, nil
}

func parseVanDykeINI(path string) (map[string]string, error) {
	content, err := readSmallTextFile(path)
	if err != nil {
		return nil, err
	}
	values := map[string]string{}
	for _, rawLine := range strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, `S:"`) || strings.HasPrefix(line, `D:"`) || strings.HasPrefix(line, `B:"`) {
			end := strings.Index(line[3:], `"`)
			if end < 0 {
				continue
			}
			key := strings.ToLower(line[3 : 3+end])
			_, value, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			value = cleanImportedScalar(value)
			if strings.HasPrefix(line, `D:"`) && len(value) == 8 {
				if parsed, err := strconv.ParseInt(value, 16, 32); err == nil {
					value = strconv.Itoa(int(parsed))
				}
			}
			values[key] = value
		}
	}
	return values, nil
}

func readSmallTextFile(path string) (string, error) {
	stat, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if stat.Size() > maxNativeSourceFileBytes {
		return "", fmt.Errorf("profile source is larger than %d MiB", maxNativeSourceFileBytes/(1024*1024))
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimPrefix(string(content), "\ufeff"), nil
}

func regularFileWithinLimit(path string) bool {
	stat, err := os.Stat(path)
	if err != nil || stat.IsDir() || stat.Size() > maxNativeSourceFileBytes {
		return false
	}
	return true
}

func regString(key registry.Key, name string) string {
	value, _, err := key.GetStringValue(name)
	if err != nil {
		return ""
	}
	return cleanImportedScalar(value)
}

func regInt(key registry.Key, name string, fallback int) int {
	value, _, err := key.GetIntegerValue(name)
	if err != nil {
		return fallback
	}
	if value < 1 || value > 65535 {
		return fallback
	}
	return int(value)
}

func decodeRegistrySessionName(raw string) string {
	if decoded, err := url.QueryUnescape(raw); err == nil && strings.TrimSpace(decoded) != "" {
		return decoded
	}
	if parsed, err := strconv.Unquote(`"` + strings.ReplaceAll(raw, `"`, `\"`) + `"`); err == nil && strings.TrimSpace(parsed) != "" {
		return parsed
	}
	return raw
}

func authSuggestionForProfile(profile Profile) string {
	if len(profile.IdentityFiles) > 0 || profile.IdentityAgent != "" {
		return "local_protected_key"
	}
	return "ca"
}

func knownKiTTYSessionRoots() []string {
	return []string{
		filepath.Join(os.Getenv("APPDATA"), "KiTTY", "Sessions"),
		filepath.Join(os.Getenv("USERPROFILE"), "Documents", "KiTTY", "Sessions"),
	}
}

func knownWinSCPINIPaths() []string {
	return []string{
		filepath.Join(os.Getenv("APPDATA"), "WinSCP.ini"),
		filepath.Join(os.Getenv("USERPROFILE"), "Documents", "WinSCP.ini"),
	}
}

func knownMobaXtermINIPaths() []string {
	return []string{
		filepath.Join(os.Getenv("USERPROFILE"), "Documents", "MobaXterm", "MobaXterm.ini"),
		filepath.Join(os.Getenv("APPDATA"), "MobaXterm", "MobaXterm.ini"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Mobatek", "MobaXterm", "MobaXterm.ini"),
	}
}

func knownMRemoteNGPaths() []string {
	return []string{filepath.Join(os.Getenv("APPDATA"), "mRemoteNG", "confCons.xml")}
}

func knownSecureCRTRoots() []string {
	return []string{
		filepath.Join(os.Getenv("APPDATA"), "VanDyke", "Config", "Sessions"),
		filepath.Join(os.Getenv("APPDATA"), "VanDyke", "SecureCRT", "Config", "Sessions"),
		filepath.Join(os.Getenv("USERPROFILE"), "Documents", "SecureCRT", "Config", "Sessions"),
	}
}

func knownXshellRoots() []string {
	return []string{
		filepath.Join(os.Getenv("USERPROFILE"), "Documents", "NetSarang Computer", "Xshell", "Sessions"),
		filepath.Join(os.Getenv("APPDATA"), "NetSarang", "Xshell", "Sessions"),
	}
}

func knownBitviseRoots() []string {
	return []string{
		filepath.Join(os.Getenv("USERPROFILE"), "Documents", "Bitvise SSH Client", "Profiles"),
		filepath.Join(os.Getenv("APPDATA"), "Bitvise SSH Client", "Profiles"),
	}
}

func knownRoyalTSRoots() []string {
	return []string{
		filepath.Join(os.Getenv("USERPROFILE"), "Documents", "Royal TS"),
		filepath.Join(os.Getenv("APPDATA"), "Royal TS"),
	}
}

func knownRDMRoots() []string {
	return []string{
		filepath.Join(os.Getenv("USERPROFILE"), "Documents", "Devolutions", "RemoteDesktopManager"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Devolutions", "RemoteDesktopManager"),
		filepath.Join(os.Getenv("APPDATA"), "Devolutions", "RemoteDesktopManager"),
	}
}

func knownTermiusExportRoots() []string {
	return []string{
		filepath.Join(os.Getenv("USERPROFILE"), "Downloads"),
		filepath.Join(os.Getenv("USERPROFILE"), "Documents", "Termius"),
	}
}

func cleanPathList(paths []string) []string {
	var result []string
	seen := map[string]struct{}{}
	for _, path := range paths {
		path = strings.TrimSpace(os.ExpandEnv(path))
		if path == "" || path == "." || path == string(filepath.Separator) {
			continue
		}
		key := strings.ToLower(path)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, path)
	}
	return result
}

func extensionAllowed(path string, extensions []string) bool {
	if len(extensions) == 0 {
		return true
	}
	ext := strings.ToLower(filepath.Ext(path))
	for _, allowed := range extensions {
		if allowed == "" || ext == strings.ToLower(allowed) {
			return true
		}
	}
	return false
}

func cleanImportedScalar(value string) string {
	value = strings.TrimSpace(value)
	value = strings.Trim(value, `"'`)
	value = strings.ReplaceAll(value, "\x00", "")
	value = strings.ReplaceAll(value, "\r", " ")
	value = strings.ReplaceAll(value, "\n", " ")
	return strings.TrimSpace(value)
}

func sanitizeProfileName(value string) string {
	value = cleanImportedScalar(value)
	if len(value) > 120 {
		value = strings.TrimSpace(value[:120])
	}
	if value == "" {
		return "imported-server"
	}
	return value
}

func splitLooseKeyValue(line string) (string, string, bool) {
	for _, sep := range []string{"=", ":"} {
		if key, value, ok := strings.Cut(line, sep); ok {
			key = strings.TrimSpace(strings.Trim(key, `"'`))
			if key == "" {
				return "", "", false
			}
			return key, value, true
		}
	}
	return "", "", false
}

func kvFirst(values map[string]string, keys ...string) string {
	for _, key := range keys {
		if value := cleanImportedScalar(values[strings.ToLower(key)]); value != "" {
			return value
		}
	}
	return ""
}

func looseKeyValues(text string) map[string]string {
	values := map[string]string{}
	replacer := strings.NewReplacer("\r", "\n", "\t", "\n", ",", "\n", ";", "\n", "%", "\n", "&", "\n")
	for _, raw := range strings.Split(replacer.Replace(text), "\n") {
		key, value, ok := splitLooseKeyValue(raw)
		if !ok {
			continue
		}
		values[strings.ToLower(key)] = cleanImportedScalar(value)
	}
	return values
}

func sectionNameTail(section string) string {
	section = strings.ReplaceAll(section, "\\", "/")
	parts := strings.Split(section, "/")
	return cleanImportedScalar(parts[len(parts)-1])
}

func sessionNameFromPath(path string, rootName string) string {
	clean := filepath.Clean(path)
	parts := strings.Split(clean, string(filepath.Separator))
	for index, part := range parts {
		if strings.EqualFold(part, rootName) && index+1 < len(parts) {
			return strings.TrimSuffix(strings.Join(parts[index+1:], "/"), filepath.Ext(path))
		}
	}
	return strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
}

func firstValidPort(fallback int, ports ...int) int {
	for _, port := range ports {
		if port >= 1 && port <= 65535 {
			return port
		}
	}
	return fallback
}

func parsePort(value string, fallback int) int {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 || parsed > 65535 {
		return fallback
	}
	return parsed
}

func splitUserHostPort(value string) (string, string, int) {
	value = cleanImportedScalar(value)
	if value == "" {
		return "", "", 0
	}
	if strings.HasPrefix(strings.ToLower(value), "ssh://") {
		if parsed, ok := parseFirstSSHURL(value); ok {
			return parsed.user, parsed.host, parsed.port
		}
	}
	user := ""
	if at := strings.LastIndex(value, "@"); at > 0 && at < len(value)-1 {
		user = value[:at]
		value = value[at+1:]
	}
	port := 0
	if host, portText, ok := strings.Cut(value, ":"); ok && !strings.Contains(host, "\\") {
		if parsed := parsePort(portText, 0); parsed > 0 {
			value = host
			port = parsed
		}
	}
	return cleanImportedScalar(user), cleanImportedScalar(value), port
}

func looksLikeSSHSessionText(value string) bool {
	lower := strings.ToLower(value)
	return strings.Contains(lower, "ssh") || strings.Contains(lower, "sftp") || strings.Contains(lower, "hostname") || strings.Contains(lower, "host=") || strings.Contains(lower, "ssh://") || strings.Contains(lower, "#109#")
}

func guessHostUserPortFromTokens(text string) (string, string, int) {
	replacer := strings.NewReplacer("\r", " ", "\n", " ", "\t", " ", "%", " ", ";", " ", ",", " ", "|", " ", "\"", " ", "'", " ")
	tokens := strings.Fields(replacer.Replace(text))
	for _, token := range tokens {
		user, host, port := splitUserHostPort(token)
		if isLikelyHost(host) {
			return host, user, firstValidPort(22, port)
		}
	}
	return "", "", 0
}

func isLikelyHost(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || strings.Contains(value, "\\") || strings.Contains(value, "/") {
		return false
	}
	if strings.Contains(value, ".") || strings.Contains(value, ":") {
		return true
	}
	for _, ch := range value {
		if ch < '0' || ch > '9' {
			return len(value) > 1
		}
	}
	return false
}

func dedupeJoin(values []string) string {
	seen := map[string]struct{}{}
	var result []string
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return strings.Join(result, " ")
}
