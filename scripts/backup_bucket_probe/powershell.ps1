# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$rootPath = [string]$env:SHELLORCHESTRA_BACKUP_ROOT_PATH
$bucketName = [string]$env:SHELLORCHESTRA_BACKUP_BUCKET_NAME
if ([string]::IsNullOrWhiteSpace($bucketName)) { $bucketName = 'ShellOrchestraBackups' }
function Write-Json($value) { $value | ConvertTo-Json -Depth 8 -Compress }
function Write-JsonError($message) { Write-Json @{ ok = $false; error = $message } }
if ([string]::IsNullOrWhiteSpace($rootPath) -or -not [System.IO.Path]::IsPathRooted($rootPath)) {
  Write-JsonError 'Backup bucket root path must be absolute.'
  exit 64
}
if ($bucketName -notmatch '^[A-Za-z0-9_.@+-]+$' -or $bucketName.StartsWith('.') -or $bucketName.Contains('..')) {
  Write-JsonError 'Backup bucket folder name contains unsupported characters.'
  exit 64
}
$bucketPath = Join-Path $rootPath $bucketName
$rootExists = Test-Path -LiteralPath $rootPath -PathType Container
$bucketExists = Test-Path -LiteralPath $bucketPath -PathType Container
$manifestPath = Join-Path $bucketPath '.shellorchestra-bucket.json'
$manifestExists = Test-Path -LiteralPath $manifestPath -PathType Leaf
$drive = $null
try { $drive = Get-PSDrive -Name ([System.IO.Path]::GetPathRoot($rootPath).Substring(0,1)) -ErrorAction Stop } catch {}
$freeBytes = 0
$totalBytes = 0
if ($drive) {
  $freeBytes = [int64]$drive.Free
  $totalBytes = [int64]($drive.Used + $drive.Free)
}
$manifestStatus = 'missing'
if ($manifestExists) { $manifestStatus = 'ok' }
Write-Json @{
  ok = $true
  root_path = $rootPath
  bucket_name = $bucketName
  bucket_path = $bucketPath
  root_exists = $rootExists
  bucket_exists = $bucketExists
  manifest_exists = $manifestExists
  manifest_status = $manifestStatus
  filesystem = 'ntfs'
  free_bytes = $freeBytes
  total_bytes = $totalBytes
}
