# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$shellOrchestraOutputEncoding = if ($env:SHELLORCHESTRA_USERS_OUTPUT_ENCODING) { $env:SHELLORCHESTRA_USERS_OUTPUT_ENCODING.ToLowerInvariant() } else { '' }
$streamFormat = if ($env:SHELLORCHESTRA_USERS_STREAM_FORMAT) { $env:SHELLORCHESTRA_USERS_STREAM_FORMAT.ToLowerInvariant() } else { 'json' }
if ($shellOrchestraOutputEncoding -and $shellOrchestraOutputEncoding -notin @('auto', 'gzip', 'zstd')) { throw "Unsupported ShellOrchestra users output encoding: $shellOrchestraOutputEncoding" }
if (-not $streamFormat) { $streamFormat = 'json' }
if ($streamFormat -notin @('json', 'row_events')) { throw "Unsupported ShellOrchestra users stream format: $streamFormat" }
$mode = if ($env:SHELLORCHESTRA_USERS_MODE) { $env:SHELLORCHESTRA_USERS_MODE } else { 'list' }
$targetUser = if ($env:SHELLORCHESTRA_USER_NAME) { $env:SHELLORCHESTRA_USER_NAME } else { '' }

function Write-ShellOrchestraUsersPayload([string]$payload) {
  $effectiveEncoding = $shellOrchestraOutputEncoding
  if ($effectiveEncoding -eq 'auto' -or $effectiveEncoding -eq 'zstd') { $effectiveEncoding = 'gzip' }
  $stdout = [Console]::OpenStandardOutput()
  if ($effectiveEncoding -eq 'gzip') {
    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $memory = New-Object System.IO.MemoryStream
    $gzip = New-Object System.IO.Compression.GzipStream -ArgumentList $memory, ([System.IO.Compression.CompressionMode]::Compress), $true
    try { $gzip.Write($bytes, 0, $bytes.Length) } finally { $gzip.Dispose() }
    $compressed = $memory.ToArray()
    $memory.Dispose()
    $stdout.Write($compressed, 0, $compressed.Length)
    $stdout.Flush()
    return
  }
  $plain = [Text.Encoding]::UTF8.GetBytes($payload)
  $stdout.Write($plain, 0, $plain.Length)
  $stdout.Flush()
}

function ConvertTo-ShellOrchestraJSONLine($value) {
  return (($value | ConvertTo-Json -Compress -Depth 10) + "`n")
}

function Emit-SSHAuthorizedKeysPayload([string]$Name) {
  if ($Name -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$') { throw 'Choose a valid user name before reading SSH authorized keys.' }
  $profilePath = Join-Path 'C:\Users' $Name
  $authorizedKeysPath = Join-Path $profilePath '.ssh\authorized_keys'
  $keys = @()
  if (Test-Path -LiteralPath $authorizedKeysPath -PathType Leaf) {
    $index = 0
    $keys = @(Get-Content -LiteralPath $authorizedKeysPath -ErrorAction SilentlyContinue | Where-Object { $_ -and $_.Trim() -and -not $_.Trim().StartsWith('#') } | ForEach-Object {
      $index += 1
      $parts = ([string]$_).Trim() -split '\s+', 3
      [ordered]@{
        index = $index
        type = if ($parts.Count -gt 0) { $parts[0] } else { '' }
        label = if ($parts.Count -gt 2) { $parts[2] } else { '' }
        line = [string]$_
      }
    })
  }
  $meta = [ordered]@{ platform='windows'; manager='local-users'; user=$Name; authorized_keys_path=$authorizedKeysPath }
  if ($streamFormat -eq 'row_events') {
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'meta'; data = $meta })))
    foreach ($key in @($keys)) { [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'row'; data = [ordered]@{ kind = 'ssh_key'; item = $key } }))) }
    [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'done'; data = $meta })))
    Write-ShellOrchestraUsersPayload $builder.ToString()
    return
  }
  Write-ShellOrchestraUsersPayload (([ordered]@{ platform='windows'; manager='local-users'; user=$Name; authorized_keys_path=$authorizedKeysPath; keys=@($keys) } | ConvertTo-Json -Depth 6 -Compress) + "`n")
}

if ($mode -eq 'ssh_keys') {
  try {
    Emit-SSHAuthorizedKeysPayload $targetUser
  } catch {
    $meta = [ordered]@{ platform='windows'; manager='local-users'; user=$targetUser; authorized_keys_path=''; message=$_.Exception.Message }
    if ($streamFormat -eq 'row_events') {
      $payload = (ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'meta'; data = $meta })) + (ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'done'; data = $meta }))
      Write-ShellOrchestraUsersPayload $payload
    } else {
      Write-ShellOrchestraUsersPayload (([ordered]@{ platform='windows'; manager='local-users'; user=$targetUser; authorized_keys_path=''; keys=@(); message=$_.Exception.Message } | ConvertTo-Json -Depth 5 -Compress) + "`n")
    }
  }
  exit 0
}

$users = @()
$canManage = $false
try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  $canManage = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {
  $canManage = $false
}
$adminSids = @{}
$groupsBySid = @{}
try {
  Get-LocalGroup -ErrorAction Stop | ForEach-Object {
    $group = [string]$_.Name
    try {
      Get-LocalGroupMember -Group $group -ErrorAction SilentlyContinue | ForEach-Object {
        if (-not $_.SID) { return }
        $sid = [string]$_.SID.Value
        if ($group -eq 'Administrators') { $adminSids[$sid] = $true }
        if (-not $groupsBySid.ContainsKey($sid)) {
          $groupsBySid[$sid] = New-Object System.Collections.Generic.List[string]
        }
        $groupsBySid[$sid].Add($group) | Out-Null
      }
    } catch {}
  }
} catch {}
try {
  $users = @(Get-LocalUser | Sort-Object Name | ForEach-Object {
    $sid = [string]$_.SID.Value
    $isAdmin = [bool]$adminSids[$sid]
    $groups = if ($groupsBySid.ContainsKey($sid)) { @($groupsBySid[$sid]) } else { @() }
    $profilePath = Join-Path 'C:\Users' ([string]$_.Name)
    $authorizedKeysPath = Join-Path $profilePath '.ssh\authorized_keys'
    $sshKeyCount = 0
    if (Test-Path -LiteralPath $authorizedKeysPath -PathType Leaf) {
      $sshKeyCount = @(Get-Content -LiteralPath $authorizedKeysPath -ErrorAction SilentlyContinue | Where-Object { $_ -and $_.Trim() -and -not $_.Trim().StartsWith('#') }).Count
    }
    [ordered]@{
      name = [string]$_.Name
      uid = $sid
      gid = ''
      full_name = [string]$_.FullName
      home = ''
      shell = 'windows'
      system = $false
      enabled = [bool]$_.Enabled
      admin = $isAdmin
      password_login_enabled = ([bool]$_.Enabled -and [bool]$_.PasswordRequired)
      password_required = [bool]$_.PasswordRequired
      password_state = if (-not $_.Enabled) { 'account-disabled' } elseif ($_.PasswordRequired) { 'password-required' } else { 'password-not-required' }
      password_last_set = if ($_.PasswordLastSet) { $_.PasswordLastSet.ToUniversalTime().ToString('o') } else { '' }
      groups = @($groups)
      ssh_key_count = [int]$sshKeyCount
      authorized_keys_path = $authorizedKeysPath
      last_login = if ($_.LastLogon) { $_.LastLogon.ToUniversalTime().ToString('o') } else { '' }
      account_expires = ''
      password_last_changed = if ($_.PasswordLastSet) { $_.PasswordLastSet.ToUniversalTime().ToString('o') } else { '' }
    }
  })
} catch {
  $meta = [ordered]@{ platform='windows'; manager='local-users'; can_manage=$canManage; message=$_.Exception.Message }
  if ($streamFormat -eq 'row_events') {
    $payload = (ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'meta'; data = $meta })) + (ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'done'; data = $meta }))
    Write-ShellOrchestraUsersPayload $payload
  } else {
    Write-ShellOrchestraUsersPayload (([ordered]@{ platform='windows'; manager='local-users'; can_manage=$canManage; users=@(); message=$_.Exception.Message } | ConvertTo-Json -Depth 5 -Compress) + "`n")
  }
  exit 0
}
$sessions = @()
try {
  $sessions = @(quser 2>$null | Select-Object -Skip 1 | ForEach-Object {
    $line = ([string]$_).Trim()
    if ($line) { [ordered]@{ user = ($line -split '\s+')[0].TrimStart('>'); tty = ''; started = $line; remote = '' } }
  })
} catch { $sessions = @() }

$meta = [ordered]@{ platform='windows'; manager='local-users'; can_manage=$canManage }
if ($streamFormat -eq 'row_events') {
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'meta'; data = $meta })))
  foreach ($session in @($sessions)) { [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'row'; data = [ordered]@{ kind = 'session'; item = $session } }))) }
  foreach ($user in @($users)) { [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'row'; data = [ordered]@{ kind = 'user'; item = $user } }))) }
  [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'done'; data = $meta })))
  Write-ShellOrchestraUsersPayload $builder.ToString()
  exit 0
}
Write-ShellOrchestraUsersPayload (([ordered]@{ platform='windows'; manager='local-users'; can_manage=$canManage; sessions=@($sessions); users=$users } | ConvertTo-Json -Depth 7 -Compress) + "`n")
