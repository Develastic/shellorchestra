# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'

function New-ShellOrchestraWarning {
    param([string]$Key, [string]$Value)
    $k = ''
    if ($null -ne $Key) { $k = [string]$Key }
    $k = $k.ToLowerInvariant()
    $v = ''
    if ($null -ne $Value) { $v = [string]$Value }
    $v = $v.ToLowerInvariant()
    if ($k -eq 'permitemptypasswords' -and $v -eq 'yes') { return @{ severity = 'critical'; warning = 'Empty passwords are permitted. This is unsafe on managed servers.'; recommended = 'no' } }
    if ($k -eq 'permitrootlogin' -and $v -eq 'yes') { return @{ severity = 'critical'; warning = 'Root login is fully enabled. Prefer certificate/key login with explicit admin users unless this host intentionally requires root.'; recommended = '' } }
    if ($k -eq 'pubkeyauthentication' -and $v -eq 'no') { return @{ severity = 'critical'; warning = 'Public key authentication is disabled. SSH CA and key based automation cannot work with this setting.'; recommended = 'yes' } }
    if ($k -eq 'passwordauthentication' -and $v -eq 'yes') { return @{ severity = 'warning'; warning = 'Password login is enabled. This increases brute-force and credential reuse risk.'; recommended = 'no' } }
    if (($k -eq 'kbdinteractiveauthentication' -or $k -eq 'challengeresponseauthentication') -and $v -eq 'yes') { return @{ severity = 'warning'; warning = 'Keyboard-interactive login is enabled. Confirm this is intentional for the server policy.'; recommended = '' } }
    if ($k -eq 'allowtcpforwarding' -and $v -eq 'yes') { return @{ severity = 'warning'; warning = 'TCP forwarding is enabled. This can be needed, but it expands what an SSH session can tunnel.'; recommended = '' } }
    if ($k -eq 'allowagentforwarding' -and $v -eq 'yes') { return @{ severity = 'warning'; warning = 'Agent forwarding is enabled. Forwarded agents can be abused by a compromised server.'; recommended = '' } }
    if ($k -eq 'x11forwarding' -and $v -eq 'yes') { return @{ severity = 'warning'; warning = 'X11 forwarding is enabled. It is rarely needed on managed servers.'; recommended = '' } }
    if ($k -eq 'gatewayports' -and $v -ne '' -and $v -ne 'no') { return @{ severity = 'warning'; warning = 'GatewayPorts can expose forwarded ports beyond localhost.'; recommended = 'no' } }
    if ($k -eq 'permittunnel' -and $v -ne '' -and $v -ne 'no') { return @{ severity = 'warning'; warning = 'SSH tunneling devices are enabled. Confirm this is intended.'; recommended = '' } }
    if ($k -eq 'permituserenvironment' -and $v -eq 'yes') { return @{ severity = 'critical'; warning = 'User-controlled environment files are enabled. This can affect command execution.'; recommended = 'no' } }
    if ($k -eq 'authorizedkeyscommand' -and $v -ne '' -and $v -ne 'none') { return @{ severity = 'info'; warning = 'AuthorizedKeysCommand executes an external helper during authentication. Review the command path and ownership.'; recommended = '' } }
    if ($k -eq 'forcecommand' -and $v -ne '') { return @{ severity = 'info'; warning = 'ForceCommand changes session behavior. Review Match context and automation impact.'; recommended = '' } }
    return @{ severity = ''; warning = ''; recommended = '' }
}

function Get-ShellOrchestraSSHDPath {
    $command = Get-Command sshd.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidates = @(
        "$env:WINDIR\System32\OpenSSH\sshd.exe",
        "$env:ProgramFiles\OpenSSH\sshd.exe"
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return ''
}

function Read-ShellOrchestraConfigLines {
    param([string]$Path)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return @() }
    return Get-Content -LiteralPath $Path -ErrorAction Stop
}

$generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$sshdPath = Get-ShellOrchestraSSHDPath
$configPath = Join-Path $env:ProgramData 'ssh\sshd_config'
$configFiles = @()
if (Test-Path -LiteralPath $configPath) { $configFiles += $configPath }
$configDir = Join-Path $env:ProgramData 'ssh\sshd_config.d'
if (Test-Path -LiteralPath $configDir) {
    $configFiles += Get-ChildItem -LiteralPath $configDir -Filter '*.conf' -File -ErrorAction SilentlyContinue | Sort-Object FullName | ForEach-Object { $_.FullName }
}
$configFiles = @($configFiles | Select-Object -Unique)
$configFileDetails = New-Object System.Collections.Generic.List[object]
foreach ($file in $configFiles) {
    $exists = Test-Path -LiteralPath $file
    $readable = $false
    $writable = $false
    $sizeBytes = 0
    $hash = ''
    $contentAvailable = $false
    $content = ''
    if ($exists) {
        try {
            $item = Get-Item -LiteralPath $file -ErrorAction Stop
            $sizeBytes = [int64]$item.Length
        } catch {
            $sizeBytes = 0
        }
        try {
            $bytes = [System.IO.File]::ReadAllBytes($file)
            $readable = $true
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try {
                $hash = 'sha256:' + ([BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant())
            } finally {
                $sha.Dispose()
            }
            if ($bytes.Length -le 262144) {
                $content = [System.Text.Encoding]::UTF8.GetString($bytes)
                $contentAvailable = $true
            }
        } catch {
            $readable = $false
        }
        try {
            $stream = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
            $stream.Dispose()
            $writable = $true
        } catch {
            $writable = $false
        }
    }
    $configFileDetails.Add([ordered]@{
        path = $file
        exists = [bool]$exists
        readable = [bool]$readable
        writable = [bool]$writable
        size_bytes = $sizeBytes
        sha256 = $hash
        content_available = [bool]$contentAvailable
        content = $content
    })
}

$service = Get-Service -Name sshd -ErrorAction SilentlyContinue
$serviceName = ''
if ($service) { $serviceName = [string]$service.Name }
$version = ''
if ($sshdPath) {
    try { $version = (& $sshdPath -V 2>&1 | Select-Object -First 1) -join '' } catch { $version = $_.Exception.Message }
}

$effectiveLines = @()
$effectiveAvailable = $false
$effectiveError = ''
if ($sshdPath -and (Test-Path -LiteralPath $configPath)) {
    try {
        $effectiveLines = @(& $sshdPath -T -f $configPath 2>&1)
        if ($LASTEXITCODE -eq 0) { $effectiveAvailable = $true } else { $effectiveError = ($effectiveLines | Select-Object -First 4) -join ' '; $effectiveLines = @() }
    } catch {
        $effectiveError = $_.Exception.Message
        $effectiveLines = @()
    }
}
$effective = @{}
foreach ($line in $effectiveLines) {
    $parts = $line -split '\s+', 2
    if ($parts.Count -ge 1) {
        $effectiveLineValue = ''
        if ($parts.Count -ge 2) { $effectiveLineValue = [string]$parts[1] }
        $effective[$parts[0].ToLowerInvariant()] = $effectiveLineValue
    }
}

$options = New-Object System.Collections.Generic.List[object]
$trustedCAs = New-Object System.Collections.Generic.List[object]
$matchBlocks = New-Object System.Collections.Generic.List[object]
foreach ($file in $configFiles) {
    $lines = Read-ShellOrchestraConfigLines -Path $file
    $inMatch = $false
    $matchStart = 0
    $matchCondition = ''
    $matchBody = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $raw = [string]$lines[$i]
        $clean = ($raw -replace '\s+#.*$', '').Trim()
        if (-not $clean) { if ($inMatch) { $matchBody.Add($raw) }; continue }
        $parts = $clean -split '\s+', 2
        $key = $parts[0]
        $value = ''
        if ($parts.Count -gt 1) { $value = [string]$parts[1] }
        if ($key.Equals('Match', [System.StringComparison]::OrdinalIgnoreCase)) {
            if ($inMatch) { $matchBlocks.Add([ordered]@{ source = $file; start_line = $matchStart; condition = $matchCondition; body = ($matchBody -join "`n") }) }
            $inMatch = $true
            $matchStart = $i + 1
            $matchCondition = $value
            $matchBody = New-Object System.Collections.Generic.List[string]
            continue
        }
        if ($key.Equals('TrustedUserCAKeys', [System.StringComparison]::OrdinalIgnoreCase)) {
            $exists = Test-Path -LiteralPath $value
            $fingerprints = @()
            if ($exists) {
                try { $fingerprints = @(ssh-keygen.exe -lf $value 2>$null | Select-Object -First 12) } catch { $fingerprints = @() }
            }
            $trustedCAs.Add([ordered]@{ path = $value; source = $file; line = $i + 1; exists = [bool]$exists; readable = [bool]$exists; fingerprints = $fingerprints })
        }
        if ($inMatch) { $matchBody.Add($raw); continue }
        $warning = New-ShellOrchestraWarning -Key $key -Value $value
        $effectiveValue = ''
        if ($effective.ContainsKey($key.ToLowerInvariant())) { $effectiveValue = [string]$effective[$key.ToLowerInvariant()] }
        $options.Add([ordered]@{ key = $key; value = $value; effective_value = $effectiveValue; source = $file; line = $i + 1; severity = $warning.severity; warning = $warning.warning; recommended = $warning.recommended })
    }
    if ($inMatch) { $matchBlocks.Add([ordered]@{ source = $file; start_line = $matchStart; condition = $matchCondition; body = ($matchBody -join "`n") }) }
}

[ordered]@{
    generated_at = $generatedAt
    platform = 'windows'
    sshd = [ordered]@{
        installed = [bool]$sshdPath
        running = [bool]($service -and $service.Status -eq 'Running')
        service_name = $serviceName
        version = $version
        config_path = $configPath
        effective_available = $effectiveAvailable
        effective_error = $effectiveError
    }
    config_files = $configFiles
    config_file_details = @($configFileDetails.ToArray())
    options = @($options.ToArray())
    trusted_user_ca_keys = @($trustedCAs.ToArray())
    match_blocks = @($matchBlocks.ToArray())
    effective_lines = @($effectiveLines)
} | ConvertTo-Json -Depth 8 -Compress
