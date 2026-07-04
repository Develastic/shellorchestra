# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}

$sourceParent = if ($env:SHELLORCHESTRA_FILE_MANAGER_SOURCE_PARENT) { [string]$env:SHELLORCHESTRA_FILE_MANAGER_SOURCE_PARENT } else { '' }
$sourceNamesB64 = if ($env:SHELLORCHESTRA_FILE_MANAGER_SOURCE_NAMES_B64) { [string]$env:SHELLORCHESTRA_FILE_MANAGER_SOURCE_NAMES_B64 } else { '' }
$compressionPreferences = if ($env:SHELLORCHESTRA_STREAM_OUTPUT_COMPRESSION) { [string]$env:SHELLORCHESTRA_STREAM_OUTPUT_COMPRESSION } else { 'none' }
$compressionLevelText = if ($env:SHELLORCHESTRA_STREAM_OUTPUT_COMPRESSION_LEVEL) { [string]$env:SHELLORCHESTRA_STREAM_OUTPUT_COMPRESSION_LEVEL } else { '3' }
$compressionLevel = 3
if (-not [int]::TryParse($compressionLevelText, [ref]$compressionLevel) -or $compressionLevel -lt 1) { $compressionLevel = 3 }
if ($compressionLevel -gt 19) { $compressionLevel = 19 }

function Fail([string]$message) { [Console]::Error.WriteLine($message); exit 2 }
function Find-ExecutableInPath([string]$Name) {
  $extensions = @('')
  if ($env:PATHEXT) {
    foreach ($extension in ($env:PATHEXT -split ';')) {
      if (-not [string]::IsNullOrWhiteSpace($extension)) { $extensions += $extension.ToLowerInvariant() }
    }
  }
  foreach ($directory in ($env:PATH -split ';')) {
    if ([string]::IsNullOrWhiteSpace($directory)) { continue }
    foreach ($extension in $extensions) {
      $candidate = Join-Path $directory ($Name + $extension)
      try { if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate } } catch {}
    }
  }
  return ''
}
function Wants-Compression([string]$name) { return (',' + $compressionPreferences.ToLowerInvariant() + ',').Contains(',' + $name.ToLowerInvariant() + ',') }
function Test-SafeArchiveName([string]$name) {
  if ([string]::IsNullOrWhiteSpace($name) -or $name -eq '.' -or $name -eq '..') { return $false }
  if ($name.StartsWith('-')) { return $false }
  if ($name.Contains('/') -or $name.Contains('\')) { return $false }
  foreach ($char in $name.ToCharArray()) { if ([char]::IsControl($char)) { return $false } }
  return $true
}

if ([string]::IsNullOrWhiteSpace($sourceParent)) { Fail 'Source parent directory is required.' }
if ([string]::IsNullOrWhiteSpace($sourceNamesB64)) { Fail 'Source names manifest is required.' }
if (-not (Test-Path -LiteralPath $sourceParent -PathType Container)) { Fail 'Source parent directory was not found.' }
$tarPath = Find-ExecutableInPath 'tar'
if (-not $tarPath) { Fail 'tar.exe is required for ShellOrchestra Send To folder and multi-item transfer.' }
try { $namesText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($sourceNamesB64)) } catch { Fail 'Source names manifest is not valid base64.' }
$names = @($namesText -split "`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($names.Count -lt 1) { Fail 'Source name manifest is empty.' }
foreach ($name in $names) {
  if (-not (Test-SafeArchiveName $name)) { Fail "Source name is not safe for archive transfer: $name" }
  $candidate = Join-Path $sourceParent $name
  if (-not (Test-Path -LiteralPath $candidate)) { Fail "Source item was not found: $name" }
}
$namesFile = [IO.Path]::GetTempFileName()
try {
  [IO.File]::WriteAllLines($namesFile, $names, [Text.UTF8Encoding]::new($false))
  if ((Wants-Compression 'zstd')) {
    $zstdPath = Find-ExecutableInPath 'zstd'
    if ($zstdPath) {
      & $tarPath -cf - -C $sourceParent -T $namesFile | & $zstdPath "-$compressionLevel" -q -c
      if ($LASTEXITCODE -ne 0) { throw "archive compression failed with exit code $LASTEXITCODE" }
      exit 0
    }
  }
  & $tarPath -cf - -C $sourceParent -T $namesFile
  if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
} finally {
  Remove-Item -LiteralPath $namesFile -Force -ErrorAction SilentlyContinue
}
