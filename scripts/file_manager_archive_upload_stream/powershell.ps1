# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}

$destinationPath = if ($env:SHELLORCHESTRA_FILE_MANAGER_PATH) { [string]$env:SHELLORCHESTRA_FILE_MANAGER_PATH } else { '' }
$overwrite = if ($env:SHELLORCHESTRA_FILE_MANAGER_OVERWRITE) { [string]$env:SHELLORCHESTRA_FILE_MANAGER_OVERWRITE } else { 'false' }
function Write-Json($value) { $value | ConvertTo-Json -Compress -Depth 8 | Write-Output }
function Write-ErrorJson([string]$message) { Write-Json ([ordered]@{ ok = $false; action = 'archive_upload'; error = $message }) }
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
function Test-SafeArchiveEntry([string]$entry) {
  if ([string]::IsNullOrWhiteSpace($entry) -or $entry -eq '.' -or $entry -eq '..') { return $false }
  if ($entry.StartsWith('/') -or $entry.StartsWith('\') -or $entry.StartsWith('-')) { return $false }
  foreach ($part in ($entry -split '[\\/]')) {
    if ($part -eq '..') { return $false }
    foreach ($char in $part.ToCharArray()) { if ([char]::IsControl($char)) { return $false } }
  }
  return $true
}

if ([string]::IsNullOrWhiteSpace($destinationPath)) { Write-ErrorJson 'Destination folder is required.'; exit 0 }
if (-not (Test-Path -LiteralPath $destinationPath -PathType Container)) { Write-ErrorJson 'Destination folder was not found.'; exit 0 }
$tarPath = Find-ExecutableInPath 'tar'
if (-not $tarPath) { Write-ErrorJson 'tar.exe is required for ShellOrchestra Send To folder and multi-item transfer.'; exit 0 }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('shellorchestra-send-to-' + [Guid]::NewGuid().ToString('N') + '.tar')
try {
  $stdin = [Console]::OpenStandardInput()
  $file = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stdin.CopyTo($file) } finally { $file.Dispose(); $stdin.Dispose() }
  $entries = @(& $tarPath -tf $tmp 2>$null)
  if ($LASTEXITCODE -ne 0) { Write-ErrorJson 'Received archive could not be listed.'; exit 0 }
  foreach ($entry in $entries) {
    $entryText = [string]$entry
    if (-not (Test-SafeArchiveEntry $entryText)) { Write-ErrorJson 'Received archive contains an unsafe entry name.'; exit 0 }
    $candidate = Join-Path $destinationPath $entryText
    if ($overwrite -ne 'true' -and (Test-Path -LiteralPath $candidate)) {
      Write-ErrorJson 'Destination already contains an item from this transfer. Enable overwrite or choose another folder.'
      exit 0
    }
  }
  & $tarPath -xf $tmp -C $destinationPath
  if ($LASTEXITCODE -ne 0) { Write-ErrorJson 'ShellOrchestra could not extract the received archive. Check file permissions for the ShellOrchestra service user.'; exit 0 }
  $item = Get-Item -LiteralPath $tmp
  Write-Json ([ordered]@{ ok = $true; action = 'archive_upload'; path = [string]$destinationPath; size = [int64]$item.Length; entry_count = [int]$entries.Count })
} catch {
  Write-ErrorJson $_.Exception.Message
} finally {
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
}
