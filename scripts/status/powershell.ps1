# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'

function Normalize-Architecture([string]$Architecture) {
  switch -Regex ($Architecture.ToUpperInvariant()) {
    '^(AMD64|X64)$' { 'amd64'; break }
    '^ARM64$' { 'arm64'; break }
    '^(X86|I386|I686)$' { '386'; break }
    default { $Architecture.ToLowerInvariant() }
  }
}

$os = Get-CimInstance Win32_OperatingSystem
$arch = Normalize-Architecture $env:PROCESSOR_ARCHITECTURE
$versionParts = @($os.Version)
if ($os.BuildNumber) {
  $versionParts += "Build $($os.BuildNumber)"
}
$cpuUsagePercent = $null
$cpuLogicalCount = 0
try {
  $processors = @(Get-CimInstance Win32_Processor -ErrorAction Stop)
  $processorSamples = @($processors | Where-Object { $null -ne $_.LoadPercentage })
  if ($processorSamples.Count -gt 0) {
    $averageLoad = ($processorSamples | Measure-Object -Property LoadPercentage -Average).Average
    if ($null -ne $averageLoad) {
      $cpuUsagePercent = [Math]::Round([double]$averageLoad, 1)
    }
  }
  foreach ($processor in $processors) {
    if ($processor.NumberOfLogicalProcessors) {
      $cpuLogicalCount += [int]$processor.NumberOfLogicalProcessors
    }
  }
} catch {
  $cpuUsagePercent = $null
  $cpuLogicalCount = 0
}
$cpuQueueLength = $null
try {
  $systemPerf = Get-CimInstance Win32_PerfFormattedData_PerfOS_System -ErrorAction Stop
  if ($null -ne $systemPerf.ProcessorQueueLength) {
    $cpuQueueLength = [int]$systemPerf.ProcessorQueueLength
  }
} catch {
  $cpuQueueLength = $null
}
$cpuMetricSource = if ($null -ne $cpuUsagePercent) { 'Win32_Processor.LoadPercentage' } else { $null }
$filesystems = @()
try {
  $filesystems = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction Stop | ForEach-Object {
      $size = if ($null -ne $_.Size) { [int64]$_.Size } else { [int64]0 }
      $free = if ($null -ne $_.FreeSpace) { [int64]$_.FreeSpace } else { [int64]0 }
      $used = [Math]::Max([int64]0, $size - $free)
      $usePercent = $null
      if ($size -gt 0) {
        $usePercent = [Math]::Round(($used / $size) * 100, 1)
      }
      [ordered]@{
        filesystem = if ($_.FileSystem) { [string]$_.FileSystem } else { 'unknown' }
        mount = [string]$_.DeviceID
        label = if ($_.VolumeName) { [string]$_.VolumeName } else { '' }
        total_bytes = $size
        used_bytes = $used
        available_bytes = $free
        use_percent = $usePercent
      }
    })
} catch {
  $filesystems = @()
}

$result = [ordered]@{
  hostname = $env:COMPUTERNAME
  username = $env:USERNAME
  shell = 'powershell'
  platform = "windows $arch"
  platform_os = 'windows'
  platform_arch = $arch
  distro_name = $os.Caption
  distro_version = ($versionParts -join ' ')
  kernel = $os.Version
  uptime_sec = [int64]((Get-Date) - $os.LastBootUpTime).TotalSeconds
  cpu_usage_percent = $cpuUsagePercent
  cpu_logical_count = $cpuLogicalCount
  cpu_metric_source = $cpuMetricSource
  cpu_queue_length = $cpuQueueLength
  load1 = $null
  load5 = $null
  load15 = $null
  mem_total_bytes = [int64]$os.TotalVisibleMemorySize * 1024
  mem_available_bytes = [int64]$os.FreePhysicalMemory * 1024
  filesystems = $filesystems
}

$result | ConvertTo-Json -Compress -Depth 5
