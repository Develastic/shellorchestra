# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$targetPath = if ($env:SHELLORCHESTRA_FILE_MANAGER_PATH) { $env:SHELLORCHESTRA_FILE_MANAGER_PATH } else { '' }
$overwrite = if ($env:SHELLORCHESTRA_FILE_MANAGER_OVERWRITE) { $env:SHELLORCHESTRA_FILE_MANAGER_OVERWRITE } else { 'false' }
function Write-ErrorJson($message) { @{ ok = $false; action = 'upload'; error = [string]$message } | ConvertTo-Json -Compress }
if ([string]::IsNullOrWhiteSpace($targetPath)) { Write-ErrorJson 'Path is required.'; exit 0 }
$parent = Split-Path -Parent $targetPath
$name = Split-Path -Leaf $targetPath
if ([string]::IsNullOrWhiteSpace($parent) -or [string]::IsNullOrWhiteSpace($name) -or $name -eq '.' -or $name -eq '..') { Write-ErrorJson 'Remote file name is invalid.'; exit 0 }
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { Write-ErrorJson 'Parent directory was not found.'; exit 0 }
if (Test-Path -LiteralPath $targetPath -PathType Container) { Write-ErrorJson 'A directory already exists at that path.'; exit 0 }
if ((Test-Path -LiteralPath $targetPath) -and $overwrite -ne 'true') { Write-ErrorJson 'A file already exists at that path. Enable overwrite or choose another name.'; exit 0 }
$tmp = Join-Path $parent ('.shellorchestra-upload.' + [Guid]::NewGuid().ToString('N') + '.tmp')
try {
  $inputStream = [Console]::OpenStandardInput()
  $outputStream = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
  Move-Item -LiteralPath $tmp -Destination $targetPath -Force
  $item = Get-Item -LiteralPath $targetPath
  $hash = try { (Get-FileHash -Algorithm SHA256 -LiteralPath $targetPath).Hash.ToLowerInvariant() } catch { '' }
  @{ ok = $true; action = 'upload'; path = [string]$item.FullName; size = [int64]$item.Length; sha256 = [string]$hash } | ConvertTo-Json -Compress
} catch {
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  Write-ErrorJson $_.Exception.Message
}
