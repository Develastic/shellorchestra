# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$sourcePath = [string]$env:SHELLORCHESTRA_BACKUP_SOURCE_PATH
$bucketPath = [string]$env:SHELLORCHESTRA_BACKUP_BUCKET_PATH
$taskId = [string]$env:SHELLORCHESTRA_BACKUP_TASK_ID
if ([string]::IsNullOrWhiteSpace($taskId)) { $taskId = 'manual' }
$compression = [string]$env:SHELLORCHESTRA_BACKUP_COMPRESSION
if ([string]::IsNullOrWhiteSpace($compression)) { $compression = 'gzip' }
$excludePatterns = [string]$env:SHELLORCHESTRA_BACKUP_EXCLUDE_PATTERNS
$keepLatest = 3
$keepWeekly = 3
$keepMonthly = 3
if ($env:SHELLORCHESTRA_BACKUP_KEEP_LATEST -match '^\d+$') { $keepLatest = [int]$env:SHELLORCHESTRA_BACKUP_KEEP_LATEST }
if ($env:SHELLORCHESTRA_BACKUP_KEEP_WEEKLY -match '^\d+$') { $keepWeekly = [int]$env:SHELLORCHESTRA_BACKUP_KEEP_WEEKLY }
if ($env:SHELLORCHESTRA_BACKUP_KEEP_MONTHLY -match '^\d+$') { $keepMonthly = [int]$env:SHELLORCHESTRA_BACKUP_KEEP_MONTHLY }

function Write-Json($value) { $value | ConvertTo-Json -Depth 8 -Compress }
function Write-JsonError($message) { Write-Json @{ ok = $false; error = $message } }
function Fail-Json($message, [int]$code) {
  Write-JsonError $message
  exit $code
}
function Safe-Token([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return 'item' }
  $token = [regex]::Replace($value, '[^A-Za-z0-9_.@+-]', '_')
  if ([string]::IsNullOrWhiteSpace($token)) { return 'item' }
  return $token
}
function Archive-Timestamp([string]$name) {
  $match = [regex]::Match($name, '-([0-9]{8}T[0-9]{6}Z)[.]tar[.].*$')
  if ($match.Success) { return $match.Groups[1].Value }
  return ''
}
function Archive-Week-Key([string]$timestamp) {
  try {
    $date = [datetime]::ParseExact($timestamp.Substring(0, 8), 'yyyyMMdd', [Globalization.CultureInfo]::InvariantCulture)
    $calendar = [Globalization.CultureInfo]::InvariantCulture.Calendar
    $week = $calendar.GetWeekOfYear($date, [Globalization.CalendarWeekRule]::FirstFourDayWeek, [DayOfWeek]::Monday)
    return ('{0:0000}-W{1:00}' -f $date.Year, $week)
  } catch {
    return $timestamp.Substring(0, [Math]::Min(8, $timestamp.Length))
  }
}
function Archive-Month-Key([string]$timestamp) {
  if ($timestamp.Length -ge 6) { return $timestamp.Substring(0, 6) }
  return $timestamp
}

if ([string]::IsNullOrWhiteSpace($sourcePath) -or -not [System.IO.Path]::IsPathRooted($sourcePath)) {
  Fail-Json 'Backup source path must be absolute.' 64
}
if ([string]::IsNullOrWhiteSpace($bucketPath) -or -not [System.IO.Path]::IsPathRooted($bucketPath)) {
  Fail-Json 'Backup bucket path must be absolute.' 64
}
if ($compression -ne 'gzip' -and $compression -ne 'zstd') {
  Fail-Json 'Backup compression must be zstd or gzip.' 64
}
if (-not (Test-Path -LiteralPath $sourcePath)) {
  Fail-Json 'Backup source path does not exist.' 66
}
if (-not (Test-Path -LiteralPath $bucketPath -PathType Container)) {
  Fail-Json 'Backup bucket path does not exist.' 66
}
$tarPath = (Get-Command 'tar.exe' -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if ([string]::IsNullOrWhiteSpace($tarPath)) {
  Fail-Json 'tar.exe is required to create backup archives on Windows.' 127
}
$zstdPath = ''
if ($compression -eq 'zstd') {
  $zstdPath = (Get-Command 'zstd.exe' -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if ([string]::IsNullOrWhiteSpace($zstdPath)) {
    Fail-Json 'zstd.exe is required for this backup task.' 127
  }
}

$sourceItem = Get-Item -LiteralPath $sourcePath -Force
$sourceParent = [System.IO.Path]::GetDirectoryName($sourceItem.FullName)
$sourceBase = [System.IO.Path]::GetFileName($sourceItem.FullName)
if ([string]::IsNullOrWhiteSpace($sourceParent) -or [string]::IsNullOrWhiteSpace($sourceBase)) {
  Fail-Json 'Backup source path must not be a drive root.' 64
}
$safeTask = Safe-Token $taskId
$safeSource = Safe-Token $sourceBase
$timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$archiveName = "shellorchestra-$safeTask-$safeSource-$timestamp.tar"
if ($compression -eq 'zstd') { $archiveName = "$archiveName.zst" } else { $archiveName = "$archiveName.gz" }
$archivePath = Join-Path $bucketPath $archiveName
$excludeFile = Join-Path $env:TEMP ("shellorchestra-backup-exclude-" + [Guid]::NewGuid().ToString() + ".txt")
$tempTar = ''

try {
  $normalizedPatterns = @()
  foreach ($raw in ($excludePatterns -split "`n")) {
    $pattern = $raw.Trim()
    if (-not $pattern -or $pattern.StartsWith('#')) { continue }
    $normalizedPatterns += $pattern.Replace('\', '/')
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllLines($excludeFile, $normalizedPatterns, $utf8NoBom)

  if ($compression -eq 'gzip') {
    $arguments = @('-czf', $archivePath, '--exclude-from', $excludeFile, '-C', $sourceParent, $sourceBase)
    & $tarPath @arguments
    if ($LASTEXITCODE -ne 0) { throw "tar.exe failed with exit code $LASTEXITCODE" }
  } else {
    $tempTar = Join-Path $env:TEMP ("shellorchestra-backup-" + [Guid]::NewGuid().ToString() + ".tar")
    $tarArguments = @('-cf', $tempTar, '--exclude-from', $excludeFile, '-C', $sourceParent, $sourceBase)
    & $tarPath @tarArguments
    if ($LASTEXITCODE -ne 0) { throw "tar.exe failed with exit code $LASTEXITCODE" }
    & $zstdPath '-3' '-q' '-f' '-o' $archivePath $tempTar
    if ($LASTEXITCODE -ne 0) { throw "zstd.exe failed with exit code $LASTEXITCODE" }
  }

  $archiveInfo = Get-Item -LiteralPath $archivePath -Force
  $allArchives = @(Get-ChildItem -LiteralPath $bucketPath -File -Filter "shellorchestra-$safeTask-*.tar.*" -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
  $keep = New-Object 'System.Collections.Generic.HashSet[string]'
  $weekKeys = New-Object 'System.Collections.Generic.HashSet[string]'
  $monthKeys = New-Object 'System.Collections.Generic.HashSet[string]'
  $latestCount = 0
  $weeklyCount = 0
  $monthlyCount = 0
  foreach ($archive in $allArchives) {
    if ($latestCount -lt $keepLatest) {
      [void]$keep.Add($archive.Name)
      $latestCount += 1
      continue
    }
    $ts = Archive-Timestamp $archive.Name
    if (-not $ts) { continue }
    if ($weeklyCount -lt $keepWeekly) {
      $weekKey = Archive-Week-Key $ts
      if ($weekKeys.Add($weekKey)) {
        [void]$keep.Add($archive.Name)
        $weeklyCount += 1
        continue
      }
    }
    if ($monthlyCount -lt $keepMonthly) {
      $monthKey = Archive-Month-Key $ts
      if ($monthKeys.Add($monthKey)) {
        [void]$keep.Add($archive.Name)
        $monthlyCount += 1
        continue
      }
    }
  }
  $pruned = 0
  foreach ($archive in $allArchives) {
    if ($keep.Contains($archive.Name)) { continue }
    Remove-Item -LiteralPath $archive.FullName -Force -ErrorAction SilentlyContinue
    $pruned += 1
  }
  Write-Json @{
    ok = $true
    archive_name = $archiveName
    archive_path = $archiveInfo.FullName
    archive_bytes = [int64]$archiveInfo.Length
    compression = $compression
    pruned_archives = $pruned
  }
} catch {
  Fail-Json ("Windows backup archive creation failed: " + $_.Exception.Message) 70
} finally {
  Remove-Item -LiteralPath $excludeFile -Force -ErrorAction SilentlyContinue
  if ($tempTar) { Remove-Item -LiteralPath $tempTar -Force -ErrorAction SilentlyContinue }
}
