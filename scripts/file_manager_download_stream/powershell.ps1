# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
try {
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
} catch {}
$targetPath = if ($env:SHELLORCHESTRA_FILE_MANAGER_PATH) { $env:SHELLORCHESTRA_FILE_MANAGER_PATH } else { '' }
$compressionPreferences = if ($env:SHELLORCHESTRA_STREAM_OUTPUT_COMPRESSION) { [string]$env:SHELLORCHESTRA_STREAM_OUTPUT_COMPRESSION } else { 'none' }
$compressionLevelText = if ($env:SHELLORCHESTRA_STREAM_OUTPUT_COMPRESSION_LEVEL) { [string]$env:SHELLORCHESTRA_STREAM_OUTPUT_COMPRESSION_LEVEL } else { '1' }
$compressionLevel = 1
if (-not [int]::TryParse($compressionLevelText, [ref]$compressionLevel) -or $compressionLevel -lt 1) { $compressionLevel = 1 }
if ($compressionLevel -gt 19) { $compressionLevel = 19 }
function Test-ShellOrchestraCompressionPreference([string]$Name) {
  return (',' + $compressionPreferences.ToLowerInvariant() + ',').Contains(',' + $Name.ToLowerInvariant() + ',')
}
function Find-ShellOrchestraExecutableInPath([string]$Name) {
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
      try {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
      } catch {}
    }
  }
  return ''
}
if ([string]::IsNullOrWhiteSpace($targetPath)) { [Console]::Error.WriteLine('Path is required.'); exit 2 }
try {
  $targetItem = Get-Item -LiteralPath $targetPath -Force -ErrorAction Stop
  if (-not $targetItem -or $targetItem.PSIsContainer) { [Console]::Error.WriteLine('Only regular files can be downloaded.'); exit 2 }
} catch {
  [Console]::Error.WriteLine('Only regular files can be downloaded.')
  exit 2
}
if ((Test-ShellOrchestraCompressionPreference 'zstd')) {
  $zstdPath = Find-ShellOrchestraExecutableInPath 'zstd'
  if ($zstdPath) {
    & $zstdPath "-$compressionLevel" '-q' '-c' '--' $targetPath
    if ($LASTEXITCODE -ne 0) { throw "zstd failed with exit code $LASTEXITCODE" }
    exit 0
  }
}
$inputStream = [IO.File]::Open($targetPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
  $outputStream = [Console]::OpenStandardOutput()
  try {
    if ((Test-ShellOrchestraCompressionPreference 'gzip')) {
      $gzipCompressionLevel = if ($compressionLevel -le 1) { [IO.Compression.CompressionLevel]::Fastest } else { [IO.Compression.CompressionLevel]::Optimal }
      $gzipStream = [IO.Compression.GZipStream]::new($outputStream, $gzipCompressionLevel, $true)
      try { $inputStream.CopyTo($gzipStream) } finally { $gzipStream.Dispose() }
    } else {
      $inputStream.CopyTo($outputStream)
    }
  } finally { $outputStream.Dispose() }
} finally { $inputStream.Dispose() }
