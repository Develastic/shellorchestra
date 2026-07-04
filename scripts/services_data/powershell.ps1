# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'

$shellOrchestraOutputEncoding = if ($env:SHELLORCHESTRA_SERVICES_OUTPUT_ENCODING) { $env:SHELLORCHESTRA_SERVICES_OUTPUT_ENCODING.ToLowerInvariant() } else { '' }
$streamFormat = if ($env:SHELLORCHESTRA_SERVICES_STREAM_FORMAT) { $env:SHELLORCHESTRA_SERVICES_STREAM_FORMAT.ToLowerInvariant() } else { 'json' }
if ($shellOrchestraOutputEncoding -and $shellOrchestraOutputEncoding -notin @('auto', 'gzip', 'zstd')) { throw "Unsupported ShellOrchestra services output encoding: $shellOrchestraOutputEncoding" }
if (-not $streamFormat) { $streamFormat = 'json' }
if ($streamFormat -notin @('json', 'row_events')) { throw "Unsupported ShellOrchestra services stream format: $streamFormat" }

function EnvValue([string]$Name, [string]$Default = '') {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ($null -eq $value) { return $Default }
  return [string]$value
}

$mode = (EnvValue 'SHELLORCHESTRA_SERVICES_MODE' 'list').Trim().ToLowerInvariant()
$serviceName = (EnvValue 'SHELLORCHESTRA_SERVICE_NAME').Trim()
$filter = (EnvValue 'SHELLORCHESTRA_SERVICES_FILTER').Trim()
$limitRaw = EnvValue 'SHELLORCHESTRA_SERVICES_LIMIT' '240'
[int]$limit = 240
if (-not [int]::TryParse($limitRaw, [ref]$limit)) { $limit = 240 }
if ($limit -lt 1) { $limit = 1 }
if ($limit -gt 1000) { $limit = 1000 }

function Write-ShellOrchestraServicesPayload([string]$payload) {
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
  return (($value | ConvertTo-Json -Compress -Depth 12) + "`n")
}

function Assert-ServiceName([string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Name) -or $Name.Length -gt 256 -or $Name -notmatch '^[A-Za-z0-9_. :@-]+$') {
    throw 'Choose a safe Windows service name.'
  }
}

function ServiceActiveState([string]$Status) {
  if ($Status -eq 'Running') { return 'active' }
  if ($Status -eq 'Stopped') { return 'inactive' }
  return $Status.ToLowerInvariant()
}

function New-ServiceRow($Service) {
  [ordered]@{
    name = [string]$Service.Name
    load = if ($null -ne $Service.StartType) { [string]$Service.StartType } else { 'installed' }
    active = ServiceActiveState ([string]$Service.Status)
    sub = [string]$Service.Status
    description = [string]$Service.DisplayName
  }
}

function New-Meta {
  [ordered]@{
    generated_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    manager = 'windows-service-control'
  }
}

function Get-ServiceBySafeName([string]$Name) {
  Assert-ServiceName $Name
  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if (-not $service) {
    $service = Get-Service -ErrorAction Stop | Where-Object { $_.Name -eq $Name } | Select-Object -First 1
  }
  if (-not $service) { throw "Windows service was not found: $Name" }
  return $service
}

function Get-ServiceCimByName([string]$Name) {
  $matches = @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $Name } | Select-Object -First 1)
  if ($matches.Count -gt 0) { return $matches[0] }
  return $null
}

if ($mode -eq 'details') {
  $service = Get-ServiceBySafeName $serviceName
  $cim = Get-ServiceCimByName $service.Name
  $payload = New-Meta
  $payload.service = [string]$service.Name
  $payload.load_state = if ($null -ne $service.StartType) { [string]$service.StartType } else { 'installed' }
  $payload.active_state = ServiceActiveState ([string]$service.Status)
  $payload.sub_state = [string]$service.Status
  $payload.unit_file_state = if ($cim -and $cim.StartMode) { [string]$cim.StartMode } else { $payload.load_state }
  $payload.fragment_path = if ($cim -and $cim.PathName) { [string]$cim.PathName } else { '' }
  $payload.active_enter_timestamp = ''
  $payload.inactive_enter_timestamp = ''
  $payload.exec_main_pid = if ($cim -and $null -ne $cim.ProcessId) { [string]$cim.ProcessId } else { '' }
  $payload.exec_main_code = ''
  $payload.exec_main_status = ''
  $payload.result = if ($cim -and $cim.State) { [string]$cim.State } else { [string]$service.Status }
  $statusLines = New-Object 'System.Collections.Generic.List[string]'
  [void]$statusLines.Add("Name: $($service.Name)")
  [void]$statusLines.Add("Display name: $($service.DisplayName)")
  [void]$statusLines.Add("Status: $($service.Status)")
  [void]$statusLines.Add("Start type: $($service.StartType)")
  if ($cim) { [void]$statusLines.Add("Account: $($cim.StartName)") }
  if ($cim) { [void]$statusLines.Add("Binary path: $($cim.PathName)") }
  $payload.status_text = ($statusLines -join "`n")
  Write-ShellOrchestraServicesPayload (($payload | ConvertTo-Json -Depth 8 -Compress) + "`n")
  exit 0
}

if ($mode -eq 'unit_file') {
  $service = Get-ServiceBySafeName $serviceName
  $payload = New-Meta
  $payload.service = [string]$service.Name
  $payload.unit_file_path = ''
  Write-ShellOrchestraServicesPayload (($payload | ConvertTo-Json -Depth 5 -Compress) + "`n")
  exit 0
}

if ($mode -eq 'logs') {
  $service = Get-ServiceBySafeName $serviceName
  $events = @()
  try {
    $events = @(Get-WinEvent -LogName System -MaxEvents 600 -ErrorAction Stop |
      Where-Object {
        $_.ProviderName -eq 'Service Control Manager' -and (
          ([string]$_.Message).IndexOf($service.Name, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
          ([string]$_.Message).IndexOf($service.DisplayName, [StringComparison]::OrdinalIgnoreCase) -ge 0
        )
      } |
      Select-Object -First $limit |
      ForEach-Object {
        [ordered]@{
          timestamp = if ($_.TimeCreated) { $_.TimeCreated.ToUniversalTime().ToString('o') } else { '' }
          message = [string]$_.Message
        }
      })
  } catch {
    $events = @([ordered]@{ timestamp = (Get-Date).ToUniversalTime().ToString('o'); message = "Windows event log query failed: $($_.Exception.Message)" })
  }
  $payload = New-Meta
  $payload.service = [string]$service.Name
  $payload.logs = @($events)
  Write-ShellOrchestraServicesPayload (($payload | ConvertTo-Json -Depth 8 -Compress) + "`n")
  exit 0
}

if ($mode -ne 'list') { throw "Unsupported services mode: $mode" }

$rows = @(Get-Service -ErrorAction Stop | Sort-Object Name | Where-Object {
  if (-not $filter) { $true } else {
    $haystack = "$($_.Name) $($_.DisplayName) $($_.Status) $($_.StartType)"
    $haystack.IndexOf($filter, [StringComparison]::OrdinalIgnoreCase) -ge 0
  }
} | Select-Object -First $limit | ForEach-Object { New-ServiceRow $_ })

$meta = New-Meta
if ($streamFormat -eq 'row_events') {
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'meta'; data = $meta })))
  foreach ($row in @($rows)) {
    [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'row'; data = $row })))
  }
  [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'done'; data = $meta })))
  Write-ShellOrchestraServicesPayload $builder.ToString()
  exit 0
}
$payload = New-Meta
$payload.services = @($rows)
Write-ShellOrchestraServicesPayload (($payload | ConvertTo-Json -Depth 8 -Compress) + "`n")
