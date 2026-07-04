# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
foreach ($cmdlet in @('Get-NetFirewallRule', 'Get-NetFirewallPortFilter', 'New-NetFirewallRule', 'Remove-NetFirewallRule', 'Set-NetFirewallProfile')) {
  if (-not (Get-Command $cmdlet -ErrorAction SilentlyContinue)) {
    throw "Windows NetSecurity cmdlet $cmdlet was not found for this SSH account."
  }
}
$action = if ($env:SHELLORCHESTRA_FIREWALL_ACTION) { $env:SHELLORCHESTRA_FIREWALL_ACTION } else { '' }
$rule = if ($env:SHELLORCHESTRA_FIREWALL_RULE) { $env:SHELLORCHESTRA_FIREWALL_RULE } else { '' }
$ruleNumber = if ($env:SHELLORCHESTRA_FIREWALL_RULE_NUMBER) { $env:SHELLORCHESTRA_FIREWALL_RULE_NUMBER } else { '' }
[int]$sshPort = 22
[void][int]::TryParse($env:SHELLORCHESTRA_SSH_PORT, [ref]$sshPort)
if ($sshPort -lt 1 -or $sshPort -gt 65535) { $sshPort = 22 }
function Test-SshRule($Port) {
  $rules = @(Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -ErrorAction SilentlyContinue | ForEach-Object {
    $ruleObject = $_
    try { $_ | Get-NetFirewallPortFilter | Where-Object { ($_.Protocol -eq 'TCP' -or $_.Protocol -eq 'Any') -and ($_.LocalPort -eq $Port -or $_.LocalPort -eq 'Any') } | ForEach-Object { $ruleObject } } catch { @() }
  })
  return $rules.Count -gt 0
}
switch ($action) {
  'enable' {
    if (-not (Test-SshRule $sshPort)) {
      New-NetFirewallRule -DisplayName "ShellOrchestra SSH $sshPort" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $sshPort -Profile Any | Out-Null
    }
    Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled True
  }
  'disable' { Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled False }
  'add_rule' {
    if ($rule -notmatch '^allow\s+([0-9]{1,5})/tcp$') { throw 'Windows firewall add rule expects: allow <port>/tcp' }
    $port = [int]$Matches[1]
    if ($port -lt 1 -or $port -gt 65535) { throw 'Firewall port must be between 1 and 65535.' }
    New-NetFirewallRule -DisplayName "ShellOrchestra TCP $port" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Any | Out-Null
  }
  'delete_rule' {
    if (-not $ruleNumber) { throw 'Windows firewall delete requires the exact ShellOrchestra rule display name.' }
    Remove-NetFirewallRule -DisplayName $ruleNumber
  }
  default { throw "Unsupported firewall action: $action" }
}
[ordered]@{ ok = $true; manager = 'windows_netsecurity'; action = $action } | ConvertTo-Json -Compress
