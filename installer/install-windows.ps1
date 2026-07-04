# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

param(
  [Parameter(HelpMessage = "Configure classic authorized_keys instead of TrustedUserCAKeys")]
  [switch]$Classic,

  [Parameter(HelpMessage = "Target Windows account for classic authorized_keys mode")]
  [string]$Account = $env:SHELLORCHESTRA_TARGET_USER,

  [Parameter(HelpMessage = "Create the target service user and add it to Administrators before writing SSH trust/key configuration")]
  [switch]$CreateUser,

  [Parameter(HelpMessage = "Set Windows OpenSSH Server default shell to PowerShell for all SSH logins on this host")]
  [switch]$SetDefaultShellPowerShell,

  [Parameter(HelpMessage = "Automatically approve OpenSSH Server installation/start/firewall setup prompts")]
  [switch]$Yes,

  [Parameter(HelpMessage = "Print help")]
  [switch]$Help,

  [Parameter(Position = 0)]
  [string]$EncodedPayload
)

$ErrorActionPreference = "Stop"
$InformationPreference = "Continue"
$HelperName = "ShellOrchestra SSH key setup helper"
$script:Report = [ordered]@{
  "Mode" = "not checked"
  "Platform" = "Windows"
  "PowerShell" = "not checked"
  "Privileges" = "not checked"
  "OpenSSH server" = "not checked"
  "OpenSSH version" = "not checked"
  "SSH config checked" = "not checked"
  "CA config target" = "not selected"
  "OpenSSH service" = "not checked"
  "OpenSSH firewall" = "not checked"
  "OpenSSH auto setup" = "not required"
  "OpenSSH default shell" = "not requested"
  "Service user" = "not requested"
  "Configuration test" = "not run"
  "Installed/updated" = "not run"
  "Reload/restart" = "not required"
}
$script:Warnings = New-Object System.Collections.Generic.List[string]

function Write-Info {
  param([string]$Message)
  Write-Information "$HelperName`: $Message"
}

function Set-Report {
  param(
    [string]$Key,
    [string]$Value
  )
  $script:Report[$Key] = $Value
}

function Add-Warning {
  param([string]$Message)
  $script:Warnings.Add($Message) | Out-Null
}

function Write-FinalReport {
  param([string]$Result)
  Write-Information ""
  Write-Information "$HelperName final report"
  Write-Information "  Result: $Result"
  foreach ($key in $script:Report.Keys) {
    Write-Information "  $key`: $($script:Report[$key])"
  }
  if ($script:Warnings.Count -gt 0) {
    Write-Information "  Warnings:"
    foreach ($warning in $script:Warnings) {
      Write-Information "    - $warning"
    }
  }
}

function Fail {
  param([string]$Message)
  throw "$HelperName error: $Message"
}

function Show-Usage {
  $usage = @"
ShellOrchestra SSH key setup helper

Usage:
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File install-windows.ps1 <CA_KEY_B64URL>
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File install-windows.ps1 -CreateUser -Account sh-orchestra <CA_KEY_B64URL>
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File install-windows.ps1 -CreateUser -Account sh-orchestra -SetDefaultShellPowerShell <CA_KEY_B64URL>
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File install-windows.ps1 -Yes -CreateUser -Account sh-orchestra <CA_KEY_B64URL>
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File install-windows.ps1 -Classic -Account USER <AUTHORIZED_KEYS_LINE_B64URL>
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File install-windows.ps1 -Classic -CreateUser -Account sh-orchestra <AUTHORIZED_KEYS_LINE_B64URL>

The helper checks Windows OpenSSH Server paths before changing SSH
configuration. The default mode writes a ShellOrchestra SSH CA public key and
configures TrustedUserCAKeys. Classic mode writes one permanent authorized_keys
line for one account and should be used only when the server deliberately does
not use SSH CA certificates. The optional -CreateUser mode creates the selected
local service account and adds it to Administrators before writing SSH
trust/key configuration. The optional -SetDefaultShellPowerShell switch writes
HKLM:\SOFTWARE\OpenSSH\DefaultShell so Windows OpenSSH starts PowerShell by
default for all SSH logins on this host. Use it when this host is dedicated to
ShellOrchestra automation or when administrators expect PowerShell SSH sessions.
If Windows OpenSSH Server is missing, stopped, disabled, or blocked by the
Windows Firewall, the helper explains the finding and asks before attempting
to install, enable, start, or open the local firewall rule. Use -Yes only when
you intentionally want those OpenSSH setup prompts approved automatically.
"@
  Write-Information $usage
}

function Confirm-AutoSetup {
  param(
    [string]$Issue,
    [string]$Action
  )
  if ($Yes.IsPresent) {
    Add-Warning "$Issue Auto-approved by -Yes: $Action"
    return
  }
  Write-Information ""
  Write-Information "$HelperName found a host setup issue:"
  Write-Information "  $Issue"
  Write-Information "Proposed automatic fix:"
  Write-Information "  $Action"
  $answer = Read-Host "Do you want ShellOrchestra to try this fix now? Type YES to continue"
  if ($answer -ne "YES") {
    Fail "$Issue Automatic setup was declined. Fix it manually or rerun this helper and approve the automatic setup."
  }
}

function Assert-PowerShellVersion {
  Set-Report -Key "PowerShell" -Value $PSVersionTable.PSVersion.ToString()
  if ($PSVersionTable.PSVersion.Major -lt 5) {
    Fail "PowerShell 5 or later is required."
  }
}

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail "Administrator privileges are required. Open PowerShell as Administrator and run the command again."
  }
  Set-Report -Key "Privileges" -Value "running as Administrator"
}

function Decode-Base64Url {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    Fail "encoded key payload is required"
  }
  if ($Value -notmatch '^[A-Za-z0-9_-]+$') {
    Fail "encoded key payload contains characters outside base64url"
  }
  $padded = $Value.Replace('-', '+').Replace('_', '/')
  switch ($padded.Length % 4) {
    0 { break }
    2 { $padded += '==' }
    3 { $padded += '=' }
    default { Fail "encoded key payload has invalid base64url length" }
  }
  try {
    $bytes = [Convert]::FromBase64String($padded)
    return ([Text.Encoding]::UTF8.GetString($bytes)).Trim()
  } catch {
    Fail "encoded key payload is not valid base64url"
  }
}

function Validate-CAKey {
  param([string]$Key)
  if ($Key -match "(`r|`n)") {
    Fail "decoded CA key must be a single line"
  }
  if ($Key -notmatch '^ssh-ed25519\s+\S+(\s+.*)?$') {
    Fail "decoded CA key is not an ssh-ed25519 OpenSSH public key"
  }
}

function Validate-AuthorizedKeyLine {
  param([string]$Line)
  if ($Line -match "(`r|`n)") {
    Fail "decoded classic payload must be a single authorized_keys line"
  }
  if ($Line -notmatch '^(ssh-ed25519\s+\S+(\s+.*)?|from="[^"]+"\s+ssh-ed25519\s+\S+(\s+.*)?)$') {
    Fail "decoded classic payload must be an ssh-ed25519 authorized_keys line"
  }
}

function Validate-ServiceUserName {
  param([string]$Name)
  if ([string]::IsNullOrWhiteSpace($Name)) {
    Fail "service user name is required"
  }
  if ($Name -eq "Administrator" -or $Name -eq "Administrators") {
    Fail "service user name must be a dedicated account, not $Name"
  }
  if ($Name -notmatch '^[A-Za-z][A-Za-z0-9_-]{0,30}$') {
    Fail "service user name must start with a letter and contain only letters, digits, underscore, or hyphen; maximum length is 31 characters"
  }
}

function Ensure-OpenSSHServerInstalled {
  $sshdExe = Join-Path $env:WINDIR "System32\OpenSSH\sshd.exe"
  if (Test-Path $sshdExe) {
    return
  }
  Confirm-AutoSetup `
    -Issue "Windows OpenSSH Server executable was not found at $sshdExe." `
    -Action "Install the Microsoft OpenSSH Server optional capability."

  $capability = Get-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0" -ErrorAction SilentlyContinue
  if ($null -eq $capability) {
    Fail "Windows OpenSSH Server optional capability was not found on this system."
  }
  if ($capability.State -ne "Installed") {
    Add-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0" -ErrorAction Stop | Out-Null
    Set-Report -Key "OpenSSH auto setup" -Value "OpenSSH Server optional capability installed"
  }
  if (!(Test-Path $sshdExe)) {
    Fail "OpenSSH Server installation completed, but sshd.exe is still missing at $sshdExe."
  }
}

function Ensure-OpenSSHConfigFile {
  $sshDir = Join-Path $env:ProgramData "ssh"
  $configPath = Join-Path $sshDir "sshd_config"
  if (Test-Path $configPath) {
    return
  }
  Confirm-AutoSetup `
    -Issue "Windows OpenSSH Server config was not found at $configPath." `
    -Action "Create ProgramData\ssh and initialize sshd_config from the Microsoft OpenSSH default config."

  New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
  $defaultConfig = Join-Path $env:WINDIR "System32\OpenSSH\sshd_config_default"
  if (!(Test-Path $defaultConfig)) {
    Fail "OpenSSH default config was not found at $defaultConfig."
  }
  Copy-Item -LiteralPath $defaultConfig -Destination $configPath -Force
  Set-Report -Key "OpenSSH auto setup" -Value "OpenSSH Server config initialized at $configPath"
}

function Ensure-OpenSSHServiceReady {
  $service = Get-Service -Name sshd -ErrorAction SilentlyContinue
  if (-not $service) {
    Confirm-AutoSetup `
      -Issue "Windows OpenSSH Server service 'sshd' is not registered." `
      -Action "Install OpenSSH Server optional capability and register the sshd service."
    Add-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0" -ErrorAction Stop | Out-Null
    $service = Get-Service -Name sshd -ErrorAction SilentlyContinue
  }
  if (-not $service) {
    Fail "OpenSSH Server service 'sshd' is not installed."
  }

  if ($service.StartType -ne "Automatic") {
    Confirm-AutoSetup `
      -Issue "Windows OpenSSH Server service 'sshd' startup type is $($service.StartType), not Automatic." `
      -Action "Set the sshd service startup type to Automatic."
    Set-Service -Name sshd -StartupType Automatic -ErrorAction Stop
    Set-Report -Key "OpenSSH auto setup" -Value "sshd startup type set to Automatic"
  }

  if ($service.Status -ne "Running") {
    Confirm-AutoSetup `
      -Issue "Windows OpenSSH Server service 'sshd' is $($service.Status), not Running." `
      -Action "Start the sshd service."
    Start-Service -Name sshd -ErrorAction Stop
    $service.WaitForStatus("Running", [TimeSpan]::FromSeconds(20))
    Set-Report -Key "OpenSSH auto setup" -Value "sshd service started"
  }
}

function Ensure-OpenSSHFirewallRule {
  $rule = Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue
  if ($rule -and $rule.Enabled -eq "True") {
    Set-Report -Key "OpenSSH firewall" -Value "OpenSSH-Server-In-TCP is enabled"
    return
  }

  $issue = if ($rule) {
    "Windows Firewall rule OpenSSH-Server-In-TCP exists but is disabled."
  } else {
    "Windows Firewall rule OpenSSH-Server-In-TCP was not found."
  }
  Confirm-AutoSetup `
    -Issue $issue `
    -Action "Enable or create a local inbound TCP/22 firewall rule for Windows OpenSSH Server."

  if ($rule) {
    Enable-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction Stop
  } else {
    New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH SSH Server (sshd)" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
  }
  Set-Report -Key "OpenSSH firewall" -Value "OpenSSH inbound TCP/22 rule is enabled"
}

function Ensure-OpenSSHServerReady {
  Ensure-OpenSSHServerInstalled
  Ensure-OpenSSHConfigFile
  Ensure-OpenSSHServiceReady
  Ensure-OpenSSHFirewallRule
}

function Get-OpenSSHServerPaths {
  $sshDir = Join-Path $env:ProgramData "ssh"
  $configPath = Join-Path $sshDir "sshd_config"
  $sshdExe = Join-Path $env:WINDIR "System32\OpenSSH\sshd.exe"
  if (!(Test-Path $sshdExe)) {
    Fail "OpenSSH Server executable was not found at $sshdExe"
  }
  if (!(Test-Path $configPath)) {
    Fail "OpenSSH Server config was not found at $configPath"
  }
  return @{
    SshDir = $sshDir
    ConfigPath = $configPath
    SshdExe = $sshdExe
  }
}

function Get-OpenSSHVersion {
  param([string]$SshdExe)
  try {
    $output = (& $SshdExe -V 2>&1 | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($output)) {
      return "version not reported by sshd -V"
    }
    return ($output -split "(`r`n|`n|`r)")[0]
  } catch {
    return "version not reported by sshd -V"
  }
}

function Configure-OpenSSHDefaultShellPowerShell {
  param([bool]$RestartService)
  $powerShellPath = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
  if (!(Test-Path $powerShellPath)) {
    Fail "Windows PowerShell executable was not found at $powerShellPath"
  }
  $registryPath = "HKLM:\SOFTWARE\OpenSSH"
  New-Item -Path $registryPath -Force | Out-Null
  $current = $null
  try {
    $current = (Get-ItemProperty -Path $registryPath -Name DefaultShell -ErrorAction Stop).DefaultShell
  } catch {
    $current = $null
  }
  if ($current -ne $powerShellPath) {
    New-ItemProperty -Path $registryPath -Name DefaultShell -Value $powerShellPath -PropertyType String -Force | Out-Null
    Set-Report -Key "OpenSSH default shell" -Value "set to $powerShellPath"
    Add-Warning "Windows OpenSSH default shell was changed for all SSH logins on this host."
  } else {
    Set-Report -Key "OpenSSH default shell" -Value "already set to $powerShellPath"
  }
  if ($RestartService) {
    Restart-Service -Name sshd -ErrorAction Stop
    Set-Report -Key "Reload/restart" -Value "Restart-Service sshd completed after default shell update"
  }
}

function Assert-LocalUserCmdlets {
  foreach ($commandName in @("Get-LocalUser", "New-LocalUser", "Get-LocalGroup", "Get-LocalGroupMember", "Add-LocalGroupMember")) {
    Get-Command -Name $commandName -ErrorAction Stop | Out-Null
  }
}

function Invoke-Preflight {
  param(
    [ValidateSet("ca", "classic")]
    [string]$Mode,
    [string]$TargetAccount,
    [bool]$CreateServiceUser
  )
  Set-Report -Key "Mode" -Value $Mode
  Ensure-OpenSSHServerReady
  $paths = Get-OpenSSHServerPaths
  $version = Get-OpenSSHVersion -SshdExe $paths.SshdExe
  Set-Report -Key "OpenSSH server" -Value $paths.SshdExe
  Set-Report -Key "OpenSSH version" -Value $version
  Set-Report -Key "SSH config checked" -Value $paths.ConfigPath
  Set-Report -Key "CA config target" -Value $(if ($Mode -eq "ca") { $paths.ConfigPath } else { "not used in classic mode" })

  $service = Get-Service -Name sshd -ErrorAction SilentlyContinue
  if (-not $service) {
    Fail "OpenSSH Server service 'sshd' is not installed."
  }
  Set-Report -Key "OpenSSH service" -Value "sshd is $($service.Status)"

  if ($CreateServiceUser) {
    Validate-ServiceUserName $TargetAccount
    Assert-LocalUserCmdlets
    Set-Report -Key "Service user" -Value "$TargetAccount (will be created if missing, then added to local Administrators)"
  } elseif ($Mode -eq "classic") {
    if ([string]::IsNullOrWhiteSpace($TargetAccount)) {
      $TargetAccount = "Administrator"
    }
    Get-AccountSid -Name $TargetAccount | Out-Null
    Set-Report -Key "Service user" -Value "existing account $TargetAccount"
  }

  Invoke-Native -Command $paths.SshdExe -Arguments @("-t", "-f", $paths.ConfigPath)
  Set-Report -Key "Configuration test" -Value "passed before changes"
  Write-Info "Preflight passed: Windows, $version, sshd service: $($service.Status)"
}

function Ensure-ServiceUser {
  param([string]$TargetAccount)
  Validate-ServiceUserName $TargetAccount
  $created = $false
  $existing = Get-LocalUser -Name $TargetAccount -ErrorAction SilentlyContinue
  if (-not $existing) {
    $passwordBytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
      $rng.GetBytes($passwordBytes)
    } finally {
      $rng.Dispose()
    }
    $passwordText = [Convert]::ToBase64String($passwordBytes)
    $password = ConvertTo-SecureString $passwordText -AsPlainText -Force
    New-LocalUser -Name $TargetAccount -FullName "ShellOrchestra" -Description "ShellOrchestra SSH service account" -Password $password -PasswordNeverExpires -AccountNeverExpires | Out-Null
    $created = $true
  }
  $adminGroup = (Get-LocalGroup -SID "S-1-5-32-544" -ErrorAction Stop).Name
  $alreadyAdmin = Get-LocalGroupMember -Group $adminGroup -ErrorAction Stop | Where-Object {
    $_.Name -eq $TargetAccount -or $_.Name.EndsWith("\$TargetAccount")
  } | Select-Object -First 1
  if (-not $alreadyAdmin) {
    Add-LocalGroupMember -Group $adminGroup -Member $TargetAccount -ErrorAction Stop
  }
  if ($created) {
    Set-Report -Key "Service user" -Value "$TargetAccount created with random password and local Administrators membership"
  } else {
    Set-Report -Key "Service user" -Value "$TargetAccount already existed; local Administrators membership verified"
  }
  Write-Info "Service user $TargetAccount exists and is a local administrator."
}

function Set-StrictFileAcl {
  param(
    [string]$Path,
    [string[]]$GrantRules
  )
  Invoke-Native -Command "icacls.exe" -Arguments @($Path, "/inheritance:r")
  Invoke-Native -Command "icacls.exe" -Arguments @($Path, "/remove:g", "*S-1-1-0", "*S-1-5-11", "*S-1-5-32-545")
  foreach ($rule in $GrantRules) {
    Invoke-Native -Command "icacls.exe" -Arguments @($Path, "/grant:r", $rule)
  }
}

function Invoke-Native {
  param(
    [string]$Command,
    [string[]]$Arguments
  )
  & $Command @Arguments | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Fail "$Command failed with exit code $LASTEXITCODE"
  }
}

function Configure-CA {
  param(
    [string]$PublicKey,
    [string]$TargetAccount,
    [bool]$CreateServiceUser
  )
  Validate-CAKey $PublicKey
  if ($CreateServiceUser) {
    Ensure-ServiceUser -TargetAccount $TargetAccount
  }
  $paths = Get-OpenSSHServerPaths
  New-Item -ItemType Directory -Force -Path $paths.SshDir | Out-Null

  $caFile = Join-Path $paths.SshDir "shellorchestra_user_ca.pub"
  Set-Content -Path $caFile -Value $PublicKey -Encoding ascii
  Set-StrictFileAcl -Path $caFile -GrantRules @("*S-1-5-18:F", "*S-1-5-32-544:F", "*S-1-5-11:R")

  $caFileForConfig = $caFile.Replace('\', '/')
  $line = "TrustedUserCAKeys $caFileForConfig"
  $content = Get-Content -Path $paths.ConfigPath -ErrorAction Stop
  $trustedLines = @($content | Where-Object { $_ -match '^\s*TrustedUserCAKeys\s+' })
  $matchingTrustedLines = @($trustedLines | Where-Object {
    $configuredPath = ($_ -replace '^\s*TrustedUserCAKeys\s+', '').Trim().Replace('\', '/')
    $configuredPath -eq $caFileForConfig
  })
  if ($trustedLines.Count -gt 0 -and $matchingTrustedLines.Count -eq 0) {
    Fail "TrustedUserCAKeys is already configured differently in $($paths.ConfigPath). Update it manually or remove the old directive before using this helper."
  }
  if ($matchingTrustedLines.Count -eq 0) {
    Add-Content -Path $paths.ConfigPath -Value "" -Encoding ascii
    Add-Content -Path $paths.ConfigPath -Value "# ShellOrchestra SSH CA" -Encoding ascii
    Add-Content -Path $paths.ConfigPath -Value $line -Encoding ascii
  }

  Invoke-Native -Command $paths.SshdExe -Arguments @("-t", "-f", $paths.ConfigPath)
  Set-Report -Key "Configuration test" -Value "passed after CA configuration change"
  Set-Report -Key "Installed/updated" -Value "CA public key written to $caFile; TrustedUserCAKeys configured in $($paths.ConfigPath)"
  Restart-Service -Name sshd -ErrorAction Stop
  Set-Report -Key "Reload/restart" -Value "Restart-Service sshd completed"
  Write-Info "OpenSSH TrustedUserCAKeys is configured."
}

function Get-AccountSid {
  param([string]$Name)
  try {
    return (New-Object Security.Principal.NTAccount($Name)).Translate([Security.Principal.SecurityIdentifier]).Value
  } catch {
    Fail "target account was not found: $Name"
  }
}

function Get-ProfileDirectory {
  param(
    [string]$Name,
    [string]$Sid
  )
  $profile = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $Sid } | Select-Object -First 1
  if ($profile -and $profile.LocalPath -and (Test-Path $profile.LocalPath)) {
    return $profile.LocalPath
  }
  $candidate = Join-Path $env:SystemDrive "Users\$Name"
  if (Test-Path $candidate) {
    return $candidate
  }
  Fail "target account profile directory was not found for $Name"
}

function Configure-Classic {
  param(
    [string]$AuthorizedKeyLine,
    [string]$TargetAccount,
    [bool]$CreateServiceUser
  )
  Validate-AuthorizedKeyLine $AuthorizedKeyLine
  if ([string]::IsNullOrWhiteSpace($TargetAccount)) {
    $TargetAccount = "Administrator"
  }
  if ($CreateServiceUser) {
    Ensure-ServiceUser -TargetAccount $TargetAccount
  }

  $paths = Get-OpenSSHServerPaths
  New-Item -ItemType Directory -Force -Path $paths.SshDir | Out-Null

  if ($TargetAccount -eq "Administrator" -or $TargetAccount -eq "Administrators") {
    $authorizedKeys = Join-Path $paths.SshDir "administrators_authorized_keys"
    if (!(Test-Path $authorizedKeys)) {
      New-Item -ItemType File -Force -Path $authorizedKeys | Out-Null
    }
    Set-StrictFileAcl -Path $authorizedKeys -GrantRules @("*S-1-5-18:F", "*S-1-5-32-544:F")
  } else {
    $sid = Get-AccountSid $TargetAccount
    $profileDir = Get-ProfileDirectory -Name $TargetAccount -Sid $sid
    $sshDir = Join-Path $profileDir ".ssh"
    $authorizedKeys = Join-Path $sshDir "authorized_keys"
    New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
    if (!(Test-Path $authorizedKeys)) {
      New-Item -ItemType File -Force -Path $authorizedKeys | Out-Null
    }
    Set-StrictFileAcl -Path $sshDir -GrantRules @("*$sid`:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F")
    Set-StrictFileAcl -Path $authorizedKeys -GrantRules @("*$sid`:F", "*S-1-5-18:F", "*S-1-5-32-544:F")
  }

  $content = if (Test-Path $authorizedKeys) { Get-Content -Path $authorizedKeys -ErrorAction Stop } else { @() }
  if ($content -notcontains $AuthorizedKeyLine) {
    Add-Content -Path $authorizedKeys -Value $AuthorizedKeyLine -Encoding ascii
    Set-Report -Key "Installed/updated" -Value "classic authorized_keys line appended to $authorizedKeys"
  } else {
    Set-Report -Key "Installed/updated" -Value "classic authorized_keys line already present in $authorizedKeys"
  }
  if ($script:Report["Reload/restart"] -like "*default shell*") {
    Set-Report -Key "Reload/restart" -Value "$($script:Report["Reload/restart"]); authorized_keys changes did not require another restart"
  } else {
    Set-Report -Key "Reload/restart" -Value "not required for authorized_keys changes"
  }
  Write-Info "authorized_keys is configured for $TargetAccount."
}

try {
  if ($Help) {
    Show-Usage
    exit 0
  }
  Assert-PowerShellVersion
  Assert-Administrator
  $payload = Decode-Base64Url $EncodedPayload
  if ($Classic) {
    if ([string]::IsNullOrWhiteSpace($Account)) {
      $Account = "Administrator"
    }
    Validate-AuthorizedKeyLine $payload
    Invoke-Preflight -Mode "classic" -TargetAccount $Account -CreateServiceUser $CreateUser.IsPresent
    if ($SetDefaultShellPowerShell) {
      Configure-OpenSSHDefaultShellPowerShell -RestartService $true
    }
    Configure-Classic -AuthorizedKeyLine $payload -TargetAccount $Account -CreateServiceUser $CreateUser.IsPresent
  } else {
    Validate-CAKey $payload
    Invoke-Preflight -Mode "ca" -TargetAccount $Account -CreateServiceUser $CreateUser.IsPresent
    if ($SetDefaultShellPowerShell) {
      Configure-OpenSSHDefaultShellPowerShell -RestartService $false
    }
    Configure-CA -PublicKey $payload -TargetAccount $Account -CreateServiceUser $CreateUser.IsPresent
  }
  Write-FinalReport -Result "success"
} catch {
  Write-Information $_
  Write-FinalReport -Result "failed"
  exit 1
}
