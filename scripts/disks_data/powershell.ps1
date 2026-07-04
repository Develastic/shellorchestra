# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$shellOrchestraOutputEncoding = if ($env:SHELLORCHESTRA_DISKS_OUTPUT_ENCODING) { $env:SHELLORCHESTRA_DISKS_OUTPUT_ENCODING.ToLowerInvariant() } else { '' }
$streamFormat = if ($env:SHELLORCHESTRA_DISKS_STREAM_FORMAT) { $env:SHELLORCHESTRA_DISKS_STREAM_FORMAT.ToLowerInvariant() } else { 'json' }
if ($shellOrchestraOutputEncoding -and $shellOrchestraOutputEncoding -notin @('auto', 'gzip')) { throw "Unsupported ShellOrchestra disks output encoding: $shellOrchestraOutputEncoding" }
if (-not $streamFormat) { $streamFormat = 'json' }
if ($streamFormat -notin @('json', 'row_events')) { throw "Unsupported ShellOrchestra disks stream format: $streamFormat" }

function Write-ShellOrchestraDisksPayload([string]$payload) {
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

function New-ShellOrchestraDiskRow($Disk) {
  return [ordered]@{
    id = "win-disk-$($Disk.number)"
    level = 0
    name = if ($Disk.name) { [string]$Disk.name } else { "Disk $($Disk.number)" }
    type = if ($Disk.bus_type) { [string]$Disk.bus_type } else { 'disk' }
    size = [int64]$Disk.size
    free = 0
    fs = [string]$Disk.partition_style
    label = [string]$Disk.media_type
    uuid = [string]$Disk.serial
    mount = ''
    model = [string]$Disk.name
    status = (@($Disk.operational_status, $Disk.health_status) | Where-Object { $_ }) -join ' · '
  }
}

function New-ShellOrchestraPartitionRow($Disk, $Partition, [int]$Index) {
  $drive = if ($Partition.drive_letter) { "$($Partition.drive_letter):\" } else { '' }
  $status = if ([int64]$Partition.size_remaining -gt 0) { "$([int64]$Partition.size_remaining) bytes free" } else { '' }
  return [ordered]@{
    id = "win-disk-$($Disk.number)-part-$Index"
    level = 1
    name = if ($Partition.number) { "Partition $($Partition.number)" } else { "Partition $($Index + 1)" }
    type = if ($Partition.type) { [string]$Partition.type } else { 'partition' }
    size = [int64]$Partition.size
    free = [int64]$Partition.size_remaining
    fs = [string]$Partition.file_system
    label = [string]$Partition.label
    uuid = [string]$Partition.gpt_type
    mount = $drive
    model = ''
    status = $status
  }
}

$disks = @()
foreach ($disk in Get-Disk -ErrorAction SilentlyContinue) {
  $partitions = @()
  foreach ($partition in Get-Partition -DiskNumber $disk.Number -ErrorAction SilentlyContinue) {
    $volume = $null
    try { $volume = $partition | Get-Volume -ErrorAction SilentlyContinue } catch { $volume = $null }
    $partitions += [ordered]@{
      number = [int]$partition.PartitionNumber
      type = [string]$partition.Type
      size = [int64]$partition.Size
      drive_letter = if ($partition.DriveLetter) { [string]$partition.DriveLetter } else { '' }
      gpt_type = [string]$partition.GptType
      offset = [int64]$partition.Offset
      file_system = if ($volume) { [string]$volume.FileSystem } else { '' }
      label = if ($volume) { [string]$volume.FileSystemLabel } else { '' }
      size_remaining = if ($volume) { [int64]$volume.SizeRemaining } else { 0 }
    }
  }
  $disks += [ordered]@{
    number = [int]$disk.Number
    name = [string]$disk.FriendlyName
    serial = [string]$disk.SerialNumber
    bus_type = [string]$disk.BusType
    media_type = [string]$disk.MediaType
    partition_style = [string]$disk.PartitionStyle
    operational_status = [string]($disk.OperationalStatus -join ', ')
    health_status = [string]$disk.HealthStatus
    size = [int64]$disk.Size
    partitions = $partitions
  }
}
$generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

if ($streamFormat -eq 'row_events') {
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'meta'; data = [ordered]@{ ok = $true; action = 'list'; platform = 'windows'; source = 'powershell-storage'; generated_at = $generatedAt; lvm_available = $false } })))
  foreach ($disk in @($disks)) {
    [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'row'; data = [ordered]@{ kind = 'disk'; item = (New-ShellOrchestraDiskRow $disk) } })))
    $partitionIndex = 0
    foreach ($partition in @($disk.partitions)) {
      [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'row'; data = [ordered]@{ kind = 'disk'; item = (New-ShellOrchestraPartitionRow $disk $partition $partitionIndex) } })))
      $partitionIndex += 1
    }
  }
  [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'done'; data = [ordered]@{ ok = $true; action = 'list'; platform = 'windows'; source = 'powershell-storage'; generated_at = $generatedAt; lvm_available = $false } })))
  Write-ShellOrchestraDisksPayload $builder.ToString()
  exit 0
}

Write-ShellOrchestraDisksPayload ((([ordered]@{ ok = $true; action = 'list'; platform = 'windows'; source = 'powershell-storage'; generated_at = $generatedAt; disks = $disks } | ConvertTo-Json -Compress -Depth 8) + "`n"))
