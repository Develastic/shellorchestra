# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'

$archivePath = if ($env:SHELLORCHESTRA_ARCHIVE_PATH) { $env:SHELLORCHESTRA_ARCHIVE_PATH } else { $env:SHELLORCHESTRA_FILE_MANAGER_PATH }
$innerPath = if ($env:SHELLORCHESTRA_ARCHIVE_INNER_PATH) { $env:SHELLORCHESTRA_ARCHIVE_INNER_PATH.Trim('/','\') } else { '' }
$maxEntries = 1000
if ($env:SHELLORCHESTRA_ARCHIVE_MAX_ENTRIES -match '^[0-9]+$') { $maxEntries = [Math]::Min(5000, [Math]::Max(1, [int]$env:SHELLORCHESTRA_ARCHIVE_MAX_ENTRIES)) }

function Write-ArchiveJson($value) { $value | ConvertTo-Json -Depth 8 -Compress | Write-Output }
function Archive-Error([string]$message) { Write-ArchiveJson ([ordered]@{ ok = $false; action = 'archive_list'; error = $message; archive_path = [string]$archivePath }) }
function Archive-Kind([string]$path) {
  $lower = $path.ToLowerInvariant()
  if ($lower -match '\.(zip|jar|war|ear|docx|xlsx|pptx|odt|ods|odp)$') { return 'zip' }
  if ($lower -match '\.rar$') { return 'rar' }
  if ($lower -match '(\.tar\.zst|\.tzst)$') { return 'tar.zst' }
  if ($lower -match '(\.tar\.gz|\.tgz)$') { return 'tar.gz' }
  if ($lower -match '(\.tar\.bz2|\.tbz2|\.tbz)$') { return 'tar.bz2' }
  if ($lower -match '(\.tar\.xz|\.txz)$') { return 'tar.xz' }
  if ($lower -match '\.tar$') { return 'tar' }
  return 'unknown'
}
function Entry-Unsafe([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) { return $true }
  if ($path.StartsWith('/') -or $path.StartsWith('\')) { return $true }
  return ($path -split '[\/]' | Where-Object { $_ -eq '..' }).Count -gt 0
}
function Normalize-ArchiveName([string]$path) { return $path.Replace('\', '/') -replace '^\./', '' }
function Read-ArchiveEntries([string]$path, [string]$kind) {
  if ($kind -eq 'zip') {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($path)
    try { return @($zip.Entries | ForEach-Object { $_.FullName }) } finally { $zip.Dispose() }
  }
  $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
  if ($tar) { return @(& $tar.Source -tf $path 2>$null) }
  throw 'Install tar.exe or use ZIP archives on Windows.'
}

if ([string]::IsNullOrWhiteSpace($archivePath)) { Archive-Error 'Archive path is required.'; exit 0 }
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { Archive-Error 'Archive path must point to a regular file.'; exit 0 }
$kind = Archive-Kind $archivePath
if ($kind -eq 'unknown') { Archive-Error 'This archive type is not supported yet.'; exit 0 }
try { $rawEntries = Read-ArchiveEntries $archivePath $kind } catch { Archive-Error ('Could not list this archive: ' + $_.Exception.Message); exit 0 }
$prefix = if ($innerPath) { (Normalize-ArchiveName $innerPath).Trim('/') + '/' } else { '' }
$entries = @()
$seen = @{}
$skipped = 0
$truncated = $false
foreach ($raw in $rawEntries) {
  $p = Normalize-ArchiveName ([string]$raw)
  if (Entry-Unsafe $p) { $skipped += 1; continue }
  if ($prefix -and -not $p.StartsWith($prefix, [StringComparison]::Ordinal)) { continue }
  $rel = if ($prefix) { $p.Substring($prefix.Length) } else { $p }
  if ([string]::IsNullOrWhiteSpace($rel)) { continue }
  $name = ($rel -split '/')[0]
  $isDir = $rel.Contains('/') -or $p.EndsWith('/')
  $type = if ($isDir) { 'directory' } else { 'file' }
  $key = $name + '|' + $type
  if ($seen.ContainsKey($key)) { continue }
  if ($entries.Count -ge $maxEntries) { $truncated = $true; break }
  $seen[$key] = $true
  $full = $prefix + $name
  $entries += [ordered]@{
    name = $name
    path = "$archivePath!/$full"
    type = $type
    is_dir = $isDir
    size = 0
    mode = 'archive'
    user = ''
    group = ''
    modified_epoch = 0
    archive_entry_path = $full
  }
}
Write-ArchiveJson ([ordered]@{
  ok = $true
  action = 'archive_list'
  platform = 'windows'
  archive_path = $archivePath
  archive_inner_path = $innerPath
  archive_type = $kind
  path = "$archivePath!/$innerPath"
  entries = @($entries)
  entry_count = $entries.Count
  skipped_entries = $skipped
  truncated = $truncated
  readonly = $true
})
