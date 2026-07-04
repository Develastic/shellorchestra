# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
function EnvValue([string]$Name, [string]$Default = '') {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ($null -eq $value) { return $Default }
  return [string]$value
}
$Action = (EnvValue 'SHELLORCHESTRA_USER_ACTION').Trim().ToLowerInvariant()
$UserName = (EnvValue 'SHELLORCHESTRA_USER_NAME').Trim()
$Password = EnvValue 'SHELLORCHESTRA_USER_PASSWORD'
$FullName = EnvValue 'SHELLORCHESTRA_USER_FULL_NAME'
$Admin = ((EnvValue 'SHELLORCHESTRA_USER_ADMIN' 'false').Trim().ToLowerInvariant() -eq 'true')
$RemoveHome = ((EnvValue 'SHELLORCHESTRA_USER_REMOVE_HOME' 'false').Trim().ToLowerInvariant() -eq 'true')
$SSHKey = EnvValue 'SHELLORCHESTRA_USER_SSH_KEY'
$GroupName = (EnvValue 'SHELLORCHESTRA_USER_GROUP').Trim()
$DryRun = EnvValue 'SHELLORCHESTRA_DRY_RUN' '0'
function Assert-UserName([string]$Value, [string]$RequestedAction) {
  if ($Value -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$') {
    throw 'Choose a valid local user name before running this action.'
  }
  $normalized = $Value.ToLowerInvariant()
  if ($RequestedAction -in @('add_ssh_key','remove_ssh_key')) {
    if ($normalized -eq 'guest') { throw 'Choose a valid local user name before editing authorized_keys.' }
    return
  }
  if ($normalized -in @('administrator','guest')) {
    throw 'Choose a valid local non-built-in user name before running this action.'
  }
}
function Assert-GroupName([string]$Value) {
  if ($Value -notmatch '^[A-Za-z_][A-Za-z0-9_.-]{0,63}$') {
    throw 'Choose a valid local group name.'
  }
}
function Write-Success([string]$Message) {
  [pscustomobject]@{ ok = $true; action = $Action; user = $UserName; message = $Message } | ConvertTo-Json -Depth 4 -Compress
}
function Secure-Password() {
  if ([string]::IsNullOrWhiteSpace($Password)) { throw 'Password is required for this action.' }
  ConvertTo-SecureString -String $Password -AsPlainText -Force
}
function Set-AdminRights([string]$Name, [bool]$Enabled) {
  if ($Enabled) {
    Add-LocalGroupMember -Group 'Administrators' -Member $Name -ErrorAction Stop
    Write-Success 'Administrator rights were granted.'
  } else {
    Remove-LocalGroupMember -Group 'Administrators' -Member $Name -ErrorAction SilentlyContinue
    Write-Success 'Administrator rights were removed.'
  }
}
function Assert-SSHPublicKey([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 8192 -or $Value -match '[\r\n\t]') { throw 'Enter a supported one-line OpenSSH public key.' }
  if ($Value -notmatch '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))\s+') { throw 'Enter a supported one-line OpenSSH public key.' }
}
function AuthorizedKeysPath([string]$Name) {
  Join-Path (Join-Path 'C:\Users' $Name) '.ssh\authorized_keys'
}
if ($Action -notin @('create','edit','set_password','lock','unlock','set_admin','add_group','remove_group','delete','add_ssh_key','remove_ssh_key')) { throw "Unsupported user action: $Action" }
Assert-UserName $UserName $Action
if ($DryRun -eq '1') { Write-Success 'Dry run completed.'; exit 0 }
switch ($Action) {
  'create' {
    if (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue) { throw "User already exists: $UserName" }
    New-LocalUser -Name $UserName -Password (Secure-Password) -FullName $FullName | Out-Null
    if ($Admin) { Add-LocalGroupMember -Group 'Administrators' -Member $UserName -ErrorAction Stop }
    Write-Success 'User was created.'
  }
  'edit' {
    $user = Get-LocalUser -Name $UserName -ErrorAction Stop
    $user | Set-LocalUser -FullName $FullName
    Write-Success 'User details were updated.'
  }
  'set_password' {
    $user = Get-LocalUser -Name $UserName -ErrorAction Stop
    $user | Set-LocalUser -Password (Secure-Password)
    Write-Success 'Password was updated.'
  }
  'lock' {
    Disable-LocalUser -Name $UserName
    Write-Success 'User account was disabled.'
  }
  'unlock' {
    Enable-LocalUser -Name $UserName
    Write-Success 'User account was enabled.'
  }
  'set_admin' {
    $null = Get-LocalUser -Name $UserName -ErrorAction Stop
    Set-AdminRights $UserName $Admin
  }
  'add_group' {
    $null = Get-LocalUser -Name $UserName -ErrorAction Stop
    Assert-GroupName $GroupName
    $null = Get-LocalGroup -Name $GroupName -ErrorAction Stop
    Add-LocalGroupMember -Group $GroupName -Member $UserName -ErrorAction Stop
    Write-Success 'User was added to the group.'
  }
  'remove_group' {
    $null = Get-LocalUser -Name $UserName -ErrorAction Stop
    Assert-GroupName $GroupName
    $null = Get-LocalGroup -Name $GroupName -ErrorAction Stop
    Remove-LocalGroupMember -Group $GroupName -Member $UserName -ErrorAction SilentlyContinue
    Write-Success 'User was removed from the group.'
  }
  'delete' {
    $null = Get-LocalUser -Name $UserName -ErrorAction Stop
    Remove-LocalUser -Name $UserName
    Write-Success 'User was deleted.'
  }
  'add_ssh_key' {
    $null = Get-LocalUser -Name $UserName -ErrorAction Stop
    Assert-SSHPublicKey $SSHKey
    $path = AuthorizedKeysPath $UserName
    $dir = Split-Path -Parent $path
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $existing = @()
    if (Test-Path -LiteralPath $path -PathType Leaf) { $existing = @(Get-Content -LiteralPath $path -ErrorAction SilentlyContinue) }
    if ($existing -contains $SSHKey) { Write-Success 'SSH public key is already installed.'; exit 0 }
    Add-Content -LiteralPath $path -Value $SSHKey -Encoding ascii
    Write-Success 'SSH public key was added.'
  }
  'remove_ssh_key' {
    $null = Get-LocalUser -Name $UserName -ErrorAction Stop
    Assert-SSHPublicKey $SSHKey
    $path = AuthorizedKeysPath $UserName
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Write-Success 'No authorized_keys file exists for this user.'; exit 0 }
    $remaining = @(Get-Content -LiteralPath $path -ErrorAction SilentlyContinue | Where-Object { [string]$_ -ne $SSHKey })
    Set-Content -LiteralPath $path -Value $remaining -Encoding ascii
    Write-Success 'SSH public key was removed.'
  }
}
