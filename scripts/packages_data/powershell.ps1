# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$action = if ($env:SHELLORCHESTRA_PACKAGE_ACTION) { $env:SHELLORCHESTRA_PACKAGE_ACTION } else { 'installed' }
$query = if ($env:SHELLORCHESTRA_PACKAGE_QUERY) { $env:SHELLORCHESTRA_PACKAGE_QUERY } else { '' }
$knownStateToken = if ($env:SHELLORCHESTRA_PACKAGE_KNOWN_STATE_TOKEN -and $env:SHELLORCHESTRA_PACKAGE_KNOWN_STATE_TOKEN -match '^[A-Za-z0-9_.:-]{1,160}$') { [string]$env:SHELLORCHESTRA_PACKAGE_KNOWN_STATE_TOKEN } else { '' }
$shellorchestraOutputEncoding = if ($env:SHELLORCHESTRA_PACKAGE_OUTPUT_ENCODING) { $env:SHELLORCHESTRA_PACKAGE_OUTPUT_ENCODING.ToLowerInvariant() } else { '' }
$shellorchestraStreamFormat = if ($env:SHELLORCHESTRA_PACKAGE_STREAM_FORMAT) { $env:SHELLORCHESTRA_PACKAGE_STREAM_FORMAT.ToLowerInvariant() } else { 'json' }
if ($shellorchestraOutputEncoding -and $shellorchestraOutputEncoding -notin @('auto', 'gzip')) { throw "Unsupported ShellOrchestra package output encoding: $shellorchestraOutputEncoding" }
if (-not $shellorchestraStreamFormat) { $shellorchestraStreamFormat = 'json' }
if ($shellorchestraStreamFormat -notin @('json', 'row_events')) { throw "Unsupported ShellOrchestra package stream format: $shellorchestraStreamFormat" }
$limit = 80
[int]::TryParse($env:SHELLORCHESTRA_PACKAGE_LIMIT, [ref]$limit) | Out-Null
if ($limit -lt 1) { $limit = 1 }
if ($limit -gt 100000) { $limit = 100000 }
$manager = if ($env:SHELLORCHESTRA_PACKAGE_MANAGER -and $env:SHELLORCHESTRA_PACKAGE_MANAGER -ne 'auto') { $env:SHELLORCHESTRA_PACKAGE_MANAGER } else { '' }
$wingetPath = ''
function Find-ShellOrchestraWinget {
    if ($env:LOCALAPPDATA) {
        $localAlias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
        if (Test-Path -LiteralPath $localAlias -PathType Leaf) {
            return $localAlias
        }
    }
    return ''
}
if (-not $manager) {
  $wingetPath = Find-ShellOrchestraWinget
  if ($wingetPath) { $manager = 'winget' }
  else { $manager = 'windows-registry' }
} elseif ($manager -eq 'winget') {
  $wingetPath = Find-ShellOrchestraWinget
} else {
  $manager = 'unknown'
}
$items = @()
$info = ''
$stateToken = ''
$notModified = $false

function Test-ShellOrchestraWingetQuery([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
  if ($Value.Length -gt 128) { return $false }
  return ($Value -match '^[A-Za-z0-9][A-Za-z0-9 ._+:#@()/-]{0,127}$')
}

function Join-ShellOrchestraWindowsArguments([string[]]$Arguments) {
  $quoted = New-Object 'System.Collections.Generic.List[string]'
  foreach ($argument in $Arguments) {
    $value = [string]$argument
    if ($value -notmatch '[\s"]') {
      [void]$quoted.Add($value)
      continue
    }
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($char in $value.ToCharArray()) {
      if ($char -eq '\') {
        $backslashes += 1
        continue
      }
      if ($char -eq '"') {
        if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
        [void]$builder.Append('\"')
        $backslashes = 0
        continue
      }
      if ($backslashes -gt 0) {
        [void]$builder.Append(('\' * $backslashes))
        $backslashes = 0
      }
      [void]$builder.Append($char)
    }
    if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
    [void]$builder.Append('"')
    [void]$quoted.Add($builder.ToString())
  }
  return ($quoted -join ' ')
}

function Invoke-ShellOrchestraWingetCapture {
  param(
    [Parameter(Mandatory = $true)][string]$WingetPath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [int]$TimeoutMilliseconds = 45000
  )
  $argumentLine = Join-ShellOrchestraWindowsArguments $Arguments
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $WingetPath
  $startInfo.Arguments = $argumentLine
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true
  $process = $null
  try {
    $process = [System.Diagnostics.Process]::Start($startInfo)
    if (-not $process) {
      return [ordered]@{ timed_out = $false; exit_code = -1; stdout = ''; stderr = 'Windows did not start a winget process for this SSH login account.' }
    }
    if (-not $process.WaitForExit($TimeoutMilliseconds)) {
      try {
        $process.Kill($true)
      } catch {
        try { & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null } catch { try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch { } }
      }
      try { [void]$process.WaitForExit(2000) } catch { }
      $stdoutTimedOut = ''
      $stderrTimedOut = ''
      try { $stdoutTimedOut = [string]$process.StandardOutput.ReadToEnd() } catch { }
      try { $stderrTimedOut = [string]$process.StandardError.ReadToEnd() } catch { }
      return [ordered]@{ timed_out = $true; exit_code = -1; stdout = $stdoutTimedOut; stderr = $stderrTimedOut }
    }
    [void]$process.WaitForExit(2000)
    $stdoutText = [string]$process.StandardOutput.ReadToEnd()
    $stderrText = [string]$process.StandardError.ReadToEnd()
    return [ordered]@{ timed_out = $false; exit_code = [int]$process.ExitCode; stdout = $stdoutText; stderr = $stderrText }
  } catch {
    return [ordered]@{ timed_out = $false; exit_code = -1; stdout = ''; stderr = $_.Exception.Message }
  } finally {
    if ($process) { $process.Dispose() }
  }
}

function Get-ShellOrchestraWingetLines {
  param(
    [Parameter(Mandatory = $true)][string]$WingetPath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [int]$TimeoutMilliseconds = 45000,
    [string]$TimeoutMessage = 'Microsoft winget did not finish before the ShellOrchestra timeout.'
  )
  $result = Invoke-ShellOrchestraWingetCapture -WingetPath $WingetPath -Arguments $Arguments -TimeoutMilliseconds $TimeoutMilliseconds
  if ($result.timed_out) {
    $script:info = $TimeoutMessage
    return @()
  }
  if ($result.exit_code -ne 0) {
    $detail = @($result.stderr, $result.stdout) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1
    if ($detail) { $script:info = ([string]$detail).Trim() }
    return @()
  }
  return @(([string]$result.stdout) -split "`r?`n")
}

function Write-ShellOrchestraPackagePayload([string]$payload) {
  $effectiveEncoding = $shellorchestraOutputEncoding
  if ($effectiveEncoding -eq 'auto') {
    $effectiveEncoding = 'gzip'
  }
  if ($effectiveEncoding -eq 'gzip') {
    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $memory = New-Object System.IO.MemoryStream
    $gzip = New-Object System.IO.Compression.GzipStream -ArgumentList $memory, ([System.IO.Compression.CompressionMode]::Compress), $true
    try {
      $gzip.Write($bytes, 0, $bytes.Length)
    } finally {
      $gzip.Dispose()
    }
    $compressed = $memory.ToArray()
    $memory.Dispose()
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($compressed, 0, $compressed.Length)
    $stdout.Flush()
    return
  }
  $stdout = [Console]::OpenStandardOutput()
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

function Write-Json($value) {
  Write-ShellOrchestraPackagePayload ((($value | ConvertTo-Json -Compress -Depth 6) + "`n"))
}

function Write-JsonEvents($events) {
  $builder = New-Object System.Text.StringBuilder
  foreach ($event in $events) {
    [void]$builder.Append(($event | ConvertTo-Json -Compress -Depth 8))
    [void]$builder.Append("`n")
  }
  Write-ShellOrchestraPackagePayload $builder.ToString()
}

function New-PackageMetadata {
  $metadataStatus = if ($manager -eq 'windows-registry') { 'unsupported' } else { 'unknown' }
  $metadataHint = if ($manager -eq 'windows-registry') { 'Installed Windows application inventory is read from the registry and does not use package repository metadata.' } else { 'ShellOrchestra could not determine Microsoft winget source metadata age from this SSH login account.' }
  return [ordered]@{
    generated_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    manager = $manager
    action = $action
    query = $query
    state_token = $stateToken
    not_modified = $notModified
    metadata_updated_at = ''
    metadata_age_seconds = $null
    metadata_status = $metadataStatus
    metadata_refresh_hint = $metadataHint
  }
}

function Get-ShellOrchestraRegistryPackageEntries {
  $registryRoots = @(
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  $entries = New-Object 'System.Collections.Generic.List[object]'
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($root in $registryRoots) {
    foreach ($entry in @(Get-ItemProperty -Path $root -ErrorAction SilentlyContinue)) {
      $displayName = if ($entry.DisplayName) { [string]$entry.DisplayName } else { '' }
      if (-not $displayName.Trim()) { continue }
      if (-not $seen.Add($displayName)) { continue }
      [void]$entries.Add([ordered]@{
        name = $displayName
        version = if ($entry.DisplayVersion) { [string]$entry.DisplayVersion } else { '' }
        description = if ($entry.Publisher) { [string]$entry.Publisher } else { '' }
        installed = $true
        upgradable = $false
      })
    }
  }
  return @($entries | Sort-Object -Property name, version, description)
}

function Get-ShellOrchestraPackageStateToken($entries) {
  $builder = New-Object System.Text.StringBuilder
  foreach ($entry in $entries) {
    [void]$builder.Append([string]$entry.name)
    [void]$builder.Append("`t")
    [void]$builder.Append([string]$entry.version)
    [void]$builder.Append("`t")
    [void]$builder.Append([string]$entry.description)
    [void]$builder.Append("`n")
  }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($builder.ToString())
  $hash = [System.Security.Cryptography.SHA256]::Create()
  try {
    $digest = $hash.ComputeHash($bytes)
  } finally {
    $hash.Dispose()
  }
  $hex = -join ($digest | ForEach-Object { $_.ToString('x2') })
  return 'v1-winreg-' + $hex.Substring(0, 32)
}

if ($action -eq 'installed' -and $manager -in @('winget', 'windows-registry')) {
  $registryEntries = @(Get-ShellOrchestraRegistryPackageEntries)
  $stateToken = Get-ShellOrchestraPackageStateToken $registryEntries
  if ($knownStateToken -and $knownStateToken -eq $stateToken) {
    $notModified = $true
  } else {
    $items = @($registryEntries | Select-Object -First $limit)
  }
} elseif ($manager -eq 'winget') {
  if (-not $wingetPath) {
    $info = 'Microsoft winget is not available to this SSH login account. Installed application inventory can still be read from the Windows registry, but search, install, remove, and upgrade need winget.'
  } elseif ($action -eq 'search' -and $query) {
    if (-not (Test-ShellOrchestraWingetQuery $query)) {
      $info = 'Enter a package id or simple search phrase up to 128 characters. ShellOrchestra does not pass quotes, shell metacharacters, or control characters to Microsoft winget.'
    } else {
      $raw = @(Get-ShellOrchestraWingetLines -WingetPath $wingetPath -Arguments @('search', '--disable-interactivity', '--accept-source-agreements', '--source', 'winget', $query) -TimeoutMilliseconds 45000 -TimeoutMessage 'Microsoft winget search did not finish within 45 seconds. The Windows package source may be refreshing, unavailable, or blocked by network/account policy. Try again after winget source update completes.')
      $items = $raw | Where-Object { $line = ([string]$_).Trim(); $line -and $line -notmatch '^[\|/-]$' -and $line -notmatch '^Name\s+Id\b' -and $line -notmatch '^-{3,}' } | Select-Object -First $limit | ForEach-Object {
        $line = [string]$_
        $parts = @($line -split '\s{2,}', 3)
        $name = if ($parts.Count -gt 0) { $parts[0].Trim() } else { $line.Trim() }
        $packageID = if ($parts.Count -gt 1) { $parts[1].Trim() } else { '' }
        if ($name) { @{ name = $name; version = ''; description = $packageID; installed = $false; upgradable = $false } }
      }
    }
  } elseif ($action -eq 'info' -and $query) {
    if (-not (Test-ShellOrchestraWingetQuery $query)) {
      $info = 'Enter a package id or simple search phrase up to 128 characters. ShellOrchestra does not pass quotes, shell metacharacters, or control characters to Microsoft winget.'
    } else {
      $info = (@(Get-ShellOrchestraWingetLines -WingetPath $wingetPath -Arguments @('show', '--disable-interactivity', '--accept-source-agreements', '--source', 'winget', $query) -TimeoutMilliseconds 45000 -TimeoutMessage 'Microsoft winget package details did not finish within 45 seconds. The Windows package source may be refreshing, unavailable, or blocked by network/account policy. Try again after winget source update completes.') | Select-Object -First 160) -join "`n"
    }
  } elseif ($action -eq 'security') {
    $info = 'Microsoft winget does not expose CVE/security advisory metadata through a stable local package-manager interface. ShellOrchestra shows this explicitly instead of guessing from package names.'
  }
} elseif ($manager -eq 'windows-registry') {
  $info = 'Microsoft winget is not available to this SSH login account. ShellOrchestra can show installed Windows applications from the registry, but package search, install, remove, and upgrade require winget.'
}
if ($shellorchestraStreamFormat -eq 'row_events') {
  $metadata = New-PackageMetadata
  $done = New-PackageMetadata
  if ($info) { $done['info'] = $info }
  $events = New-Object 'System.Collections.Generic.List[object]'
  [void]$events.Add([ordered]@{ event = 'meta'; data = $metadata })
  if (-not $notModified) {
    foreach ($item in @($items)) {
      [void]$events.Add([ordered]@{ event = 'row'; data = $item })
    }
  }
  [void]$events.Add([ordered]@{ event = 'done'; data = $done })
  Write-JsonEvents $events
} else {
  $payload = New-PackageMetadata
  $payload['packages'] = @($items)
  $payload['info'] = $info
  Write-Json $payload
}
exit 0
