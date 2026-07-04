# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$Action = if ($env:SHELLORCHESTRA_NETWORK_ACTION) { $env:SHELLORCHESTRA_NETWORK_ACTION.Trim().ToLowerInvariant() } else { '' }
$Interface = if ($env:SHELLORCHESTRA_NETWORK_INTERFACE) { $env:SHELLORCHESTRA_NETWORK_INTERFACE.Trim() } else { '' }
$HostnameValue = if ($env:SHELLORCHESTRA_NETWORK_HOSTNAME) { $env:SHELLORCHESTRA_NETWORK_HOSTNAME.Trim() } else { '' }
$Mtu = if ($env:SHELLORCHESTRA_NETWORK_MTU) { $env:SHELLORCHESTRA_NETWORK_MTU.Trim() } else { '' }
$Dns = if ($env:SHELLORCHESTRA_NETWORK_DNS) { $env:SHELLORCHESTRA_NETWORK_DNS.Trim() } else { '' }
$DryRun = $env:SHELLORCHESTRA_DRY_RUN -eq '1'
function Write-Success([string]$Message) { [pscustomobject]@{ ok=$true; action=$Action; dry_run=$DryRun; message=$Message } | ConvertTo-Json -Compress -Depth 4 }
function Assert-Interface() { if ($Interface -notmatch '^[A-Za-z0-9 _.-]{1,128}$') { throw 'Choose a valid network interface.' } }
switch ($Action) {
  'set_hostname' {
    if ($HostnameValue -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$' -or $HostnameValue.EndsWith('-')) { throw 'Enter a valid host name before saving.' }
    if ($DryRun) {
      Write-Success 'Preview only. ShellOrchestra would rename this Windows computer. Windows may require a restart before every component reports the new name.'
      exit 0
    }
    Rename-Computer -NewName $HostnameValue -Force
    Write-Success 'Computer name was updated. Windows may require a restart before every component reports the new name.'
  }
  'set_mtu' {
    Assert-Interface
    [int]$parsedMtu = 0
    if (-not [int]::TryParse($Mtu, [ref]$parsedMtu) -or $parsedMtu -lt 576 -or $parsedMtu -gt 9000) { throw 'MTU must be between 576 and 9000.' }
    if ($DryRun) {
      Write-Success 'Preview only. ShellOrchestra would set the runtime MTU on this Windows interface.'
      exit 0
    }
    Set-NetIPInterface -InterfaceAlias $Interface -NlMtuBytes $parsedMtu
    Write-Success 'Interface MTU was updated.'
  }
  'set_dns' {
    Assert-Interface
    $servers = @($Dns -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($servers.Count -eq 0) { throw 'Enter comma-separated DNS server IP addresses.' }
    foreach ($server in $servers) { if ($server -notmatch '^[0-9A-Fa-f:.]+$') { throw 'DNS servers must be IP addresses.' } }
    if ($DryRun) {
      Write-Success 'Preview only. ShellOrchestra would set DNS servers on this Windows interface.'
      exit 0
    }
    Set-DnsClientServerAddress -InterfaceAlias $Interface -ServerAddresses $servers
    Write-Success 'DNS servers were updated for this interface.'
  }
  default { throw "Unsupported network action: $Action" }
}
