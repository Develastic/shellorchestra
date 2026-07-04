# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'

$limitRaw = $env:SHELLORCHESTRA_PROCESS_LIMIT
[int]$limit = 40
if ([int]::TryParse($limitRaw, [ref]$limit) -eq $false) {
  $limit = 40
}
if ($limit -lt 1) { $limit = 1 }
if ($limit -gt 200) { $limit = 200 }

$shellOrchestraOutputEncoding = if ($env:SHELLORCHESTRA_PROCESS_OUTPUT_ENCODING) { $env:SHELLORCHESTRA_PROCESS_OUTPUT_ENCODING.ToLowerInvariant() } else { '' }
$streamFormat = if ($env:SHELLORCHESTRA_PROCESS_STREAM_FORMAT) { $env:SHELLORCHESTRA_PROCESS_STREAM_FORMAT.ToLowerInvariant() } else { 'json' }
if ($shellOrchestraOutputEncoding -and $shellOrchestraOutputEncoding -notin @('auto', 'gzip')) { throw "Unsupported ShellOrchestra process output encoding: $shellOrchestraOutputEncoding" }
if (-not $streamFormat) { $streamFormat = 'json' }
if ($streamFormat -notin @('json', 'row_events')) { throw "Unsupported ShellOrchestra process stream format: $streamFormat" }

function Write-ShellOrchestraProcessPayload([string]$payload) {
  $effectiveEncoding = $shellOrchestraOutputEncoding
  if ($effectiveEncoding -eq 'auto') {
    $effectiveEncoding = 'gzip'
  }
  $stdout = [Console]::OpenStandardOutput()
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
    $stdout.Write($compressed, 0, $compressed.Length)
    $stdout.Flush()
    return
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

function Write-JsonPayload($value) {
  Write-ShellOrchestraProcessPayload ((($value | ConvertTo-Json -Compress -Depth 6) + "`n"))
}

function Write-JsonEvents($events) {
  $builder = New-Object System.Text.StringBuilder
  foreach ($event in $events) {
    [void]$builder.Append(($event | ConvertTo-Json -Compress -Depth 8))
    [void]$builder.Append("`n")
  }
  Write-ShellOrchestraProcessPayload $builder.ToString()
}

function New-ProcessMetadata {
  return [ordered]@{
    generated_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    platform = 'windows'
    source = 'Get-Process'
  }
}

function Get-ProcessNumericProperty($process, [string]$name) {
  $property = $process.PSObject.Properties[$name]
  if ($null -eq $property -or $null -eq $property.Value) { return $null }
  try {
    return [int64]$property.Value
  } catch {
    return $null
  }
}

$tcpCounts = @{}
$tcpListeningCounts = @{}
$tcpEstablishedCounts = @{}
try {
  foreach ($connection in @(Get-NetTCPConnection -ErrorAction Stop)) {
    $processId = [int]$connection.OwningProcess
    if ($processId -le 0) { continue }
    if (-not $tcpCounts.ContainsKey($processId)) { $tcpCounts[$processId] = 0; $tcpListeningCounts[$processId] = 0; $tcpEstablishedCounts[$processId] = 0 }
    $tcpCounts[$processId]++
    if ($connection.State -eq 'Listen') { $tcpListeningCounts[$processId]++ }
    if ($connection.State -eq 'Established') { $tcpEstablishedCounts[$processId]++ }
  }
} catch {
}

$udpCounts = @{}
try {
  foreach ($endpoint in @(Get-NetUDPEndpoint -ErrorAction Stop)) {
    $processId = [int]$endpoint.OwningProcess
    if ($processId -le 0) { continue }
    if (-not $udpCounts.ContainsKey($processId)) { $udpCounts[$processId] = 0 }
    $udpCounts[$processId]++
  }
} catch {
}

$processes = @(Get-Process -ErrorAction Stop |
  Sort-Object -Property @{Expression = { if ($null -ne $_.CPU) { $_.CPU } else { 0 } }; Descending = $true}, WorkingSet64 -Descending |
  Select-Object -First $limit |
  ForEach-Object {
    $processId = [int]$_.Id
    $tcpTotal = if ($tcpCounts.ContainsKey($processId)) { [int]$tcpCounts[$processId] } else { 0 }
    $udpTotal = if ($udpCounts.ContainsKey($processId)) { [int]$udpCounts[$processId] } else { 0 }
    $networkTotal = $tcpTotal + $udpTotal
    [ordered]@{
      pid = $processId
      user = ''
      cpu_seconds = if ($null -ne $_.CPU) { [Math]::Round([double]$_.CPU, 1) } else { $null }
      memory_bytes = [int64]$_.WorkingSet64
      disk_read_bytes = Get-ProcessNumericProperty $_ 'IOReadBytes'
      disk_write_bytes = Get-ProcessNumericProperty $_ 'IOWriteBytes'
      network_connections = $networkTotal
      network_listening = if ($tcpListeningCounts.ContainsKey($processId)) { [int]$tcpListeningCounts[$processId] } else { 0 }
      network_established = if ($tcpEstablishedCounts.ContainsKey($processId)) { [int]$tcpEstablishedCounts[$processId] } else { 0 }
      state = if ($_.Responding) { 'running' } else { 'not responding' }
      command = [string]$_.ProcessName
    }
  })

if ($streamFormat -eq 'row_events') {
  $events = New-Object 'System.Collections.Generic.List[object]'
  [void]$events.Add([ordered]@{ event = 'meta'; data = (New-ProcessMetadata) })
  foreach ($process in @($processes)) {
    [void]$events.Add([ordered]@{ event = 'row'; data = $process })
  }
  [void]$events.Add([ordered]@{ event = 'done'; data = (New-ProcessMetadata) })
  Write-JsonEvents $events
  return
}

$payload = New-ProcessMetadata
$payload['processes'] = $processes
Write-JsonPayload $payload
