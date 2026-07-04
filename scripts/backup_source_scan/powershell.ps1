# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$sourcePath = [string]$env:SHELLORCHESTRA_BACKUP_SOURCE_PATH
$excludePatterns = [string]$env:SHELLORCHESTRA_BACKUP_EXCLUDE_PATTERNS
$maxEntries = 200000
if ($env:SHELLORCHESTRA_BACKUP_SCAN_MAX_ENTRIES -match '^\d+$') { $maxEntries = [int]$env:SHELLORCHESTRA_BACKUP_SCAN_MAX_ENTRIES }
function Write-Json($value) { $value | ConvertTo-Json -Depth 8 -Compress }
function Write-JsonError($message) { Write-Json @{ ok = $false; error = $message } }
if ([string]::IsNullOrWhiteSpace($sourcePath) -or -not [System.IO.Path]::IsPathRooted($sourcePath)) {
  Write-JsonError 'Backup source path must be absolute.'
  exit 64
}
if (-not (Test-Path -LiteralPath $sourcePath)) {
  Write-JsonError 'Backup source path does not exist.'
  exit 66
}
$patterns = @($excludePatterns -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })
function Is-Excluded([string]$relativePath) {
  foreach ($pattern in $patterns) {
    $p = $pattern.TrimStart('!')
    if (-not $p) { continue }
    if ($p.EndsWith('/')) {
      $prefix = $p.TrimEnd('/')
      if ($relativePath -eq $prefix -or $relativePath.StartsWith("$prefix/") -or $relativePath.Contains("/$prefix/")) { return $true }
    } elseif ($relativePath -like $p -or $relativePath -like "*/$p") {
      return $true
    }
  }
  return $false
}
$item = Get-Item -LiteralPath $sourcePath -Force
$kind = 'file'
if ($item.PSIsContainer) { $kind = 'directory' }
$files = if ($item.PSIsContainer) {
  Get-ChildItem -LiteralPath $sourcePath -File -Recurse -Force -ErrorAction SilentlyContinue | Select-Object -First $maxEntries
} else {
  @($item)
}
$originalCount = 0
$originalBytes = [int64]0
$includedCount = 0
$includedBytes = [int64]0
foreach ($file in $files) {
  $originalCount++
  $originalBytes += [int64]$file.Length
  $relative = '.'
  if ($item.PSIsContainer) {
    $basePath = $sourcePath -replace '[\\/]+$',''
    $relative = $file.FullName
    if ($relative.StartsWith($basePath, [System.StringComparison]::OrdinalIgnoreCase)) {
      $relative = $relative.Substring($basePath.Length) -replace '^[\\/]+',''
    }
    $relative = $relative.Replace('\','/')
  }
  if (-not (Is-Excluded $relative)) {
    $includedCount++
    $includedBytes += [int64]$file.Length
  }
}
Write-Json @{
  ok = $true
  source_path = $sourcePath
  kind = $kind
  original_file_count = $originalCount
  original_disk_bytes = $originalBytes
  included_file_count = $includedCount
  included_disk_bytes = $includedBytes
  excluded_file_count = ($originalCount - $includedCount)
  excluded_disk_bytes = ($originalBytes - $includedBytes)
  truncated = ($originalCount -ge $maxEntries)
}
