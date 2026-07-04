# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$shellOrchestraOutputEncoding = if ($env:SHELLORCHESTRA_CONNECTION_WATCH_OUTPUT_ENCODING) { $env:SHELLORCHESTRA_CONNECTION_WATCH_OUTPUT_ENCODING.ToLowerInvariant() } else { '' }
$streamFormat = if ($env:SHELLORCHESTRA_CONNECTION_WATCH_STREAM_FORMAT) { $env:SHELLORCHESTRA_CONNECTION_WATCH_STREAM_FORMAT.ToLowerInvariant() } else { 'json' }
if ($shellOrchestraOutputEncoding -and $shellOrchestraOutputEncoding -notin @('auto', 'gzip')) { throw "Unsupported ShellOrchestra connection watch output encoding: $shellOrchestraOutputEncoding" }
if (-not $streamFormat) { $streamFormat = 'json' }
if ($streamFormat -notin @('json', 'row_events')) { throw "Unsupported ShellOrchestra connection watch stream format: $streamFormat" }

function ConvertTo-Direction([string]$Protocol, [string]$State, [int]$LocalPort, [int]$RemotePort) {
  if ($State -eq 'Listen' -or $State -eq 'Bound' -or $RemotePort -eq 0) { return 'listening' }
  if ($LocalPort -gt 0 -and $RemotePort -gt 0 -and $LocalPort -lt 49152 -and $RemotePort -ge 49152) { return 'incoming' }
  return 'outgoing'
}
function Split-NetstatEndpoint([string]$Endpoint) {
  $value = if ($Endpoint) { $Endpoint.Trim() } else { '' }
  if (-not $value -or $value -eq '*:*') { return @{ address = ''; port = 0 } }
  if ($value.StartsWith('[')) {
    $closing = $value.LastIndexOf(']')
    if ($closing -ge 0) {
      $address = $value.Substring(1, $closing - 1)
      $portText = ''
      if ($value.Length -gt ($closing + 2) -and $value.Substring($closing + 1, 1) -eq ':') {
        $portText = $value.Substring($closing + 2)
      }
      [int]$port = 0
      [void][int]::TryParse($portText, [ref]$port)
      return @{ address = $address; port = $port }
    }
  }
  $separator = $value.LastIndexOf(':')
  if ($separator -lt 0) { return @{ address = $value; port = 0 } }
  $addressPart = $value.Substring(0, $separator)
  $portPart = $value.Substring($separator + 1)
  [int]$parsedPort = 0
  [void][int]::TryParse($portPart, [ref]$parsedPort)
  return @{ address = $addressPart; port = $parsedPort }
}
function Process-Label([uint32]$ProcessID) {
  if ($ProcessID -le 0) { return '' }
  try { $p = Get-Process -Id ([int]$ProcessID) -ErrorAction Stop; return "$($p.ProcessName) pid=$ProcessID" } catch { return "pid=$ProcessID" }
}
function Write-ShellOrchestraConnectionPayload([string]$payload) {
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

$connections = @()
$source = 'nettcpip'
try {
  $connections += Get-NetTCPConnection | ForEach-Object {
    $state = [string]$_.State
    [pscustomobject]@{
      protocol = 'tcp'
      direction = ConvertTo-Direction 'tcp' $state ([int]$_.LocalPort) ([int]$_.RemotePort)
      state = $state
      local_address = [string]$_.LocalAddress
      local_port = [string]$_.LocalPort
      remote_address = [string]$_.RemoteAddress
      remote_port = [string]$_.RemotePort
      process = Process-Label $_.OwningProcess
    }
  }
} catch {}
try {
  $connections += Get-NetUDPEndpoint | ForEach-Object {
    [pscustomobject]@{
      protocol = 'udp'
      direction = 'listening'
      state = 'Bound'
      local_address = [string]$_.LocalAddress
      local_port = [string]$_.LocalPort
      remote_address = ''
      remote_port = ''
      process = Process-Label $_.OwningProcess
    }
  }
} catch {}
if (@($connections).Count -eq 0) {
  $source = 'netstat'
  try {
    $connections = @(netstat -ano | ForEach-Object {
      $line = ([string]$_).Trim()
      if ($line -and $line -match '^(TCP|UDP)\s+') {
        $parts = @($line -split '\s+' | Where-Object { $_ })
        $protocol = $parts[0].ToLowerInvariant()
        if ($protocol -eq 'tcp' -and $parts.Count -ge 5) {
          $local = Split-NetstatEndpoint $parts[1]
          $remote = Split-NetstatEndpoint $parts[2]
          $state = $parts[3]
          [uint32]$processID = 0
          [void][uint32]::TryParse($parts[4], [ref]$processID)
          [pscustomobject]@{
            protocol = 'tcp'
            direction = ConvertTo-Direction 'tcp' $state ([int]$local.port) ([int]$remote.port)
            state = $state
            local_address = [string]$local.address
            local_port = [string]$local.port
            remote_address = [string]$remote.address
            remote_port = [string]$remote.port
            process = Process-Label $processID
          }
        } elseif ($protocol -eq 'udp' -and $parts.Count -ge 4) {
          $local = Split-NetstatEndpoint $parts[1]
          [uint32]$processID = 0
          [void][uint32]::TryParse($parts[$parts.Count - 1], [ref]$processID)
          [pscustomobject]@{
            protocol = 'udp'
            direction = 'listening'
            state = 'Bound'
            local_address = [string]$local.address
            local_port = [string]$local.port
            remote_address = ''
            remote_port = ''
            process = Process-Label $processID
          }
        }
      }
    })
  } catch { $connections = @() }
}
$generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
if ($streamFormat -eq 'row_events') {
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'meta'; data = [ordered]@{ generated_at = $generatedAt; platform = 'windows'; source = $source } })))
  foreach ($connection in @($connections)) {
    [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'row'; data = $connection })))
  }
  [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'done'; data = [ordered]@{ generated_at = $generatedAt; platform = 'windows'; source = $source } })))
  Write-ShellOrchestraConnectionPayload $builder.ToString()
  exit 0
}
Write-ShellOrchestraConnectionPayload ((([pscustomobject]@{ generated_at = $generatedAt; platform = 'windows'; source = $source; connections = $connections } | ConvertTo-Json -Depth 6 -Compress) + "`n"))
