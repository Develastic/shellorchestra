# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$shellOrchestraOutputEncoding = if ($env:SHELLORCHESTRA_LAN_WATCH_OUTPUT_ENCODING) { $env:SHELLORCHESTRA_LAN_WATCH_OUTPUT_ENCODING.ToLowerInvariant() } else { '' }
$streamFormat = if ($env:SHELLORCHESTRA_LAN_WATCH_STREAM_FORMAT) { $env:SHELLORCHESTRA_LAN_WATCH_STREAM_FORMAT.ToLowerInvariant() } else { 'json' }
if ($shellOrchestraOutputEncoding -and $shellOrchestraOutputEncoding -notin @('auto', 'gzip')) { throw "Unsupported ShellOrchestra LAN Watch output encoding: $shellOrchestraOutputEncoding" }
if (-not $streamFormat) { $streamFormat = 'json' }
if ($streamFormat -notin @('json', 'row_events')) { throw "Unsupported ShellOrchestra LAN Watch stream format: $streamFormat" }

function Write-ShellOrchestraLanWatchPayload([string]$payload) {
  $effectiveEncoding = $shellOrchestraOutputEncoding
  if ($effectiveEncoding -eq 'auto') { $effectiveEncoding = 'gzip' }
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
  return (($value | ConvertTo-Json -Compress -Depth 8) + "`n")
}

$limit = 64
$noProbe = $env:SHELLORCHESTRA_LAN_WATCH_NO_PROBE -eq '1' -or $env:SHELLORCHESTRA_LAN_WATCH_NO_PROBE -eq 'true'
if ($env:SHELLORCHESTRA_LAN_WATCH_LIMIT -match '^[0-9]+$') { $limit = [int]$env:SHELLORCHESTRA_LAN_WATCH_LIMIT }
if ($limit -lt 1) { $limit = 1 }
if ($limit -gt 256) { $limit = 256 }
function Prefix24([string]$Address) { $parts = $Address.Split('.'); if ($parts.Count -ne 4) { return '' }; return "$($parts[0]).$($parts[1]).$($parts[2])" }
$probeBackend = 'powershell-tcpclient'
$probeBackendMissing = $false
$probeBackendMessage = 'TCP banner probing uses PowerShell .NET TcpClient on this server.'
try {
  [void][System.Net.Sockets.TcpClient]
} catch {
  $probeBackend = 'none'
  $probeBackendMissing = $true
  $probeBackendMessage = 'PowerShell .NET TcpClient is not available to this SSH session, so LAN Watch cannot actively check TCP/22 or read SSH banners.'
}
if ($noProbe) {
  $probeBackend = 'disabled'
  $probeBackendMissing = $false
  $probeBackendMessage = 'TCP banner probing is disabled for this scan.'
}
function Read-SshBanner([string]$Address) {
  if ($noProbe) { return '' }
  if ($probeBackendMissing) { return '' }
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $async = $client.BeginConnect($Address, 22, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(350)) { return '' }
    $client.EndConnect($async)
    $stream = $client.GetStream()
    $stream.ReadTimeout = 500
    $buffer = New-Object byte[] 256
    $count = $stream.Read($buffer, 0, $buffer.Length)
    if ($count -le 0) { return '' }
    return ([System.Text.Encoding]::ASCII.GetString($buffer, 0, $count)).Trim()
  } catch { return '' }
  finally { $client.Close() }
}
$subnets = @()
$hosts = @()
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -and $_.IPAddress -notmatch '^127\.' -and $_.PrefixLength -le 30 }
$count = 0
$candidateCount = 0
foreach ($ip in $ips) {
  $base = Prefix24 ([string]$ip.IPAddress)
  if (-not $base) { continue }
  $subnets += [ordered]@{ interface = [string]$ip.InterfaceAlias; address = [string]$ip.IPAddress; prefix = [string]$ip.PrefixLength; network = "$base.0/24" }
  $candidateCount += 254
  for ($n = 1; $n -le 254 -and $count -lt $limit; $n++) {
    $addr = "$base.$n"
    $banner = Read-SshBanner $addr
    $neighbor = Get-NetNeighbor -IPAddress $addr -ErrorAction SilentlyContinue | Select-Object -First 1
    $mac = ''
    if ($neighbor) { $mac = [string]$neighbor.LinkLayerAddress }
    $realMac = $mac -and ($mac -notmatch '^(00[-:]){5}00$')
    if ($banner -or $realMac) { $hosts += [ordered]@{ ip = $addr; mac = $mac; interface = [string]$ip.InterfaceAlias; ssh_open = $banner.StartsWith('SSH-'); ssh_banner = $banner } }
    $count++
  }
}
$remaining = $candidateCount - $count
if ($remaining -lt 0) { $remaining = 0 }
$meta = [ordered]@{
  generated_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  platform = 'windows'
  source = 'nettcpip'
  limit = $limit
  no_probe = $noProbe
  candidate_count = $candidateCount
  checked = $count
  remaining = $remaining
  probe_backend = $probeBackend
  probe_backend_available = (-not $probeBackendMissing)
  probe_backend_missing = $probeBackendMissing
  probe_backend_message = $probeBackendMessage
}
if ($streamFormat -eq 'row_events') {
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'meta'; data = $meta })))
  foreach ($subnet in @($subnets)) {
    [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'row'; data = [ordered]@{ kind = 'subnet'; item = $subnet } })))
  }
  foreach ($hostItem in @($hosts)) {
    [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'row'; data = [ordered]@{ kind = 'host'; item = $hostItem } })))
  }
  [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'done'; data = $meta })))
  Write-ShellOrchestraLanWatchPayload $builder.ToString()
  exit 0
}
$payload = [ordered]@{}
foreach ($key in $meta.Keys) { $payload[$key] = $meta[$key] }
$payload.subnets = $subnets
$payload.hosts = $hosts
Write-ShellOrchestraLanWatchPayload (($payload | ConvertTo-Json -Depth 6 -Compress) + "`n")
