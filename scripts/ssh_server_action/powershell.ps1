# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'

$action = $env:SHELLORCHESTRA_SSH_SERVER_ACTION
$targetPath = $env:SHELLORCHESTRA_SSH_SERVER_PATH
$targetContent = $env:SHELLORCHESTRA_SSH_SERVER_CONTENT
$expectedHash = $env:SHELLORCHESTRA_SSH_SERVER_EXPECTED_HASH
$mainConfig = $env:SHELLORCHESTRA_SSH_SERVER_MAIN_CONFIG
$backupPath = $env:SHELLORCHESTRA_SSH_SERVER_BACKUP_PATH

function Write-ShellOrchestraJson {
    param(
        [string]$Mode,
        [bool]$Ok,
        [string]$Message,
        [string]$Backup = '',
        [bool]$Reloaded = $false
    )
    [ordered]@{
        ok = $Ok
        action = $Mode
        path = $targetPath
        backup_path = $Backup
        reloaded = $Reloaded
        message = $Message
    } | ConvertTo-Json -Depth 4 -Compress
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

function Test-ShellOrchestraConfigPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    if ($Path.Trim() -ne $Path) { return $false }
    if ($Path.Contains([char]0)) { return $false }
    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetFullPath((Join-Path $env:ProgramData 'ssh'))
    $main = [System.IO.Path]::GetFullPath((Join-Path $root 'sshd_config'))
    $includeRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'sshd_config.d'))
    if ($full.Equals($main, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($full.StartsWith($includeRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        $name = [System.IO.Path]::GetFileName($full)
        if ($name -match '^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}\.conf$') { return $true }
    }
    return $false
}

function Test-ShellOrchestraBackupPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    if ($Path.Trim() -ne $Path) { return $false }
    if ($Path.Contains([char]0)) { return $false }
    $full = [System.IO.Path]::GetFullPath($Path)
    $backupRoot = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $env:ProgramData 'ssh') '.shellorchestra-backups'))
    return $full.StartsWith($backupRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-ShellOrchestraSHA256 {
    param([string]$Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try {
            return 'sha256:' + ([BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant())
        } finally {
            $stream.Dispose()
        }
    } finally {
        $sha.Dispose()
    }
}

function Test-ShellOrchestraSSHDConfig {
    param([string]$ConfigPath)
    $sshd = Get-ShellOrchestraSSHDPath
    if (-not $sshd) {
        throw 'OpenSSH sshd.exe was not found on this server.'
    }
    $output = @(& $sshd -t -f $ConfigPath 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw (($output | Select-Object -First 8) -join "`n")
    }
}

function Restart-ShellOrchestraSSHD {
    $service = Get-Service -Name sshd -ErrorAction SilentlyContinue
    if (-not $service) { return $false }
    Restart-Service -Name sshd -Force -ErrorAction Stop
    return $true
}

if ($action -notin @('validate', 'apply', 'rollback')) {
    throw "Unsupported SSH Server action: $action"
}
if (-not (Test-ShellOrchestraConfigPath -Path $targetPath)) {
    throw 'Choose a supported OpenSSH server config file before saving.'
}
if ([string]::IsNullOrWhiteSpace($mainConfig)) {
    $mainConfig = Join-Path $env:ProgramData 'ssh\sshd_config'
}
if (-not (Test-ShellOrchestraConfigPath -Path $mainConfig)) {
    throw 'Choose a supported OpenSSH main config path before validation.'
}

if ($action -eq 'validate') {
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText($tmp, $targetContent + "`n", [System.Text.UTF8Encoding]::new($false))
        Test-ShellOrchestraSSHDConfig -ConfigPath $tmp
        Write-ShellOrchestraJson -Mode 'validate' -Ok $true -Message 'Draft passed OpenSSH sshd syntax validation.'
    } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
    exit 0
}

if ($action -eq 'rollback') {
    if (-not (Test-ShellOrchestraBackupPath -Path $backupPath)) {
        throw 'Choose a ShellOrchestra OpenSSH backup before rollback.'
    }
    if (-not (Test-Path -LiteralPath $backupPath)) {
        throw 'The selected OpenSSH backup file does not exist.'
    }
    Copy-Item -LiteralPath $backupPath -Destination $targetPath -Force
    Test-ShellOrchestraSSHDConfig -ConfigPath $mainConfig
    $reloaded = Restart-ShellOrchestraSSHD
    Write-ShellOrchestraJson -Mode 'rollback' -Ok $true -Message ($(if ($reloaded) { 'Backup restored and OpenSSH service reloaded.' } else { 'Backup restored and validated, but ShellOrchestra could not reload OpenSSH automatically. Reload sshd manually.' })) -Backup $backupPath -Reloaded $reloaded
    exit 0
}

if (-not (Test-Path -LiteralPath $targetPath)) {
    throw 'The target OpenSSH config file does not exist.'
}
$currentHash = Get-ShellOrchestraSHA256 -Path $targetPath
if ($currentHash -ne $expectedHash) {
    throw 'OpenSSH config changed after it was loaded. Refresh SSH Server before applying this draft.'
}
$backupDir = Join-Path (Split-Path -Parent $targetPath) '.shellorchestra-backups'
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$backupName = ([System.IO.Path]::GetFileName($targetPath)) + '.' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '.bak'
$backupFile = Join-Path $backupDir $backupName
Copy-Item -LiteralPath $targetPath -Destination $backupFile -Force
try {
    [System.IO.File]::WriteAllText($targetPath, $targetContent + "`n", [System.Text.UTF8Encoding]::new($false))
    Test-ShellOrchestraSSHDConfig -ConfigPath $mainConfig
} catch {
    Copy-Item -LiteralPath $backupFile -Destination $targetPath -Force
    throw ("OpenSSH validation failed. ShellOrchestra restored the previous config from backup. " + $_.Exception.Message)
}
$didReload = Restart-ShellOrchestraSSHD
Write-ShellOrchestraJson -Mode 'apply' -Ok $true -Message ($(if ($didReload) { 'OpenSSH config was validated, saved, backed up, and the service was reloaded.' } else { 'OpenSSH config was validated and saved, but ShellOrchestra could not reload OpenSSH automatically. Reload sshd manually.' })) -Backup $backupFile -Reloaded $didReload
