# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$shellOrchestraOutputEncoding = if ($env:SHELLORCHESTRA_NETWORK_CONNECTIONS_OUTPUT_ENCODING) { $env:SHELLORCHESTRA_NETWORK_CONNECTIONS_OUTPUT_ENCODING.ToLowerInvariant() } else { '' }
$streamFormat = if ($env:SHELLORCHESTRA_NETWORK_CONNECTIONS_STREAM_FORMAT) { $env:SHELLORCHESTRA_NETWORK_CONNECTIONS_STREAM_FORMAT.ToLowerInvariant() } else { 'json' }
if ($shellOrchestraOutputEncoding -and $shellOrchestraOutputEncoding -notin @('auto', 'gzip', 'zstd')) { throw "Unsupported ShellOrchestra network connections output encoding: $shellOrchestraOutputEncoding" }
if (-not $streamFormat) { $streamFormat = 'json' }
if ($streamFormat -notin @('json', 'row_events')) { throw "Unsupported ShellOrchestra network connections stream format: $streamFormat" }

function Write-ShellOrchestraNetworkConnectionsPayload([string]$payload) {
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

function Get-ShellOrchestraDnsSearchDomains {
  $domains = @()
  try {
    $global = Get-DnsClientGlobalSetting -ErrorAction SilentlyContinue
    if ($global -and $global.SuffixSearchList) { $domains += @($global.SuffixSearchList) }
  } catch {}
  try {
    $domains += @(Get-DnsClient -ErrorAction SilentlyContinue | ForEach-Object { $_.ConnectionSpecificSuffix } | Where-Object { $_ })
  } catch {}
  @($domains | Where-Object { $_ } | Sort-Object -Unique)
}

function Get-ShellOrchestraRoutes {
  try {
    @(Get-NetRoute -ErrorAction Stop | Sort-Object InterfaceAlias, DestinationPrefix, RouteMetric | ForEach-Object {
      [ordered]@{
        destination = [string]$_.DestinationPrefix
        gateway = if ($_.NextHop) { [string]$_.NextHop } else { '' }
        interface_name = if ($_.InterfaceAlias) { [string]$_.InterfaceAlias } else { '' }
        source_address = ''
        metric = if ($null -ne $_.RouteMetric) { [string]$_.RouteMetric } else { '' }
        is_default = ($_.DestinationPrefix -eq '0.0.0.0/0' -or $_.DestinationPrefix -eq '::/0')
      }
    })
  } catch { @() }
}

function Get-ShellOrchestraSshPath($Adapters) {
  $parts = @()
  if ($env:SSH_CONNECTION) { $parts = @(([string]$env:SSH_CONNECTION) -split '\s+' | Where-Object { $_ }) }
  $clientAddress = if ($parts.Count -ge 1) { [string]$parts[0] } else { '' }
  $serverAddress = if ($parts.Count -ge 3) { [string]$parts[2] } else { '' }
  $serverPort = if ($parts.Count -ge 4) { [string]$parts[3] } else { '' }
  $interfaceName = ''
  $sourceAddress = ''
  if ($serverAddress) {
    foreach ($adapter in @($Adapters)) {
      foreach ($address in @($adapter.addresses)) {
        $addressText = [string]$address
        $match = [regex]::Match($addressText, '^[^:]+:(.+?)(?:/\d+)?$')
        if ($match.Success -and $match.Groups[1].Value -eq $serverAddress) {
          $interfaceName = [string]$adapter.name
          $sourceAddress = $serverAddress
          break
        }
      }
      if ($interfaceName) { break }
    }
  }
  if (-not $interfaceName -and $clientAddress) {
    try {
      $route = Find-NetRoute -RemoteIPAddress $clientAddress -ErrorAction Stop | Select-Object -First 1
      if ($route) {
        if ($route.InterfaceAlias) { $interfaceName = [string]$route.InterfaceAlias }
        if ($route.InterfaceIndex) {
          $source = Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4,IPv6 -ErrorAction SilentlyContinue | Select-Object -First 1
          if ($source) { $sourceAddress = [string]$source.IPAddress }
        }
      }
    } catch {}
  }
  [ordered]@{
    client_address = $clientAddress
    server_address = $serverAddress
    server_port = $serverPort
    interface_name = $interfaceName
    source_address = $sourceAddress
    route_known = [bool]$interfaceName
  }
}

$dns = @()
try { $dns = @(Get-DnsClientServerAddress -AddressFamily IPv4,IPv6 | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ } | Sort-Object -Unique) } catch { $dns = @() }
$dnsSearchDomains = @(Get-ShellOrchestraDnsSearchDomains)
$routes = @(Get-ShellOrchestraRoutes)
$adapters = @()
$message = ''
try {
  $adapters = @(Get-NetAdapter | Sort-Object Name | ForEach-Object {
    $adapter = $_
    $ip = @(Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress } | ForEach-Object { "$($_.AddressFamily):$($_.IPAddress)/$($_.PrefixLength)" })
    $gateway = ''
    $route = Get-NetRoute -InterfaceIndex $adapter.ifIndex -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1
    if ($route) { $gateway = [string]$route.NextHop }
    [ordered]@{
      name = [string]$adapter.Name
      type = [string]$adapter.InterfaceDescription
      state = [string]$adapter.Status
      mtu = [string]$adapter.MtuSize
      mac = [string]$adapter.MacAddress
      gateway = $gateway
      addresses = $ip
    }
  })
} catch {
  $message = $_.Exception.Message
  $adapters = @()
}
$sshPath = Get-ShellOrchestraSshPath $adapters
$meta = [ordered]@{
  platform = 'windows'
  manager = 'nettcpip'
  hostname = [string]$env:COMPUTERNAME
  dns = $dns
  dns_search_domains = $dnsSearchDomains
  ssh_path = $sshPath
}
if ($message) { $meta.message = $message }

if ($streamFormat -eq 'row_events') {
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'meta'; data = $meta })))
  foreach ($route in @($routes)) {
    [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'row'; data = [ordered]@{ kind = 'route'; item = $route } })))
  }
  foreach ($adapter in @($adapters)) {
    [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'row'; data = [ordered]@{ kind = 'adapter'; item = $adapter } })))
  }
  [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'done'; data = $meta })))
  Write-ShellOrchestraNetworkConnectionsPayload $builder.ToString()
  exit 0
}
$payload = [ordered]@{}
foreach ($key in $meta.Keys) { $payload[$key] = $meta[$key] }
$payload.routes = $routes
$payload.adapters = $adapters
Write-ShellOrchestraNetworkConnectionsPayload (($payload | ConvertTo-Json -Depth 10 -Compress) + "`n")
