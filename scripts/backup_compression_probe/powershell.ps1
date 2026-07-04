# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
function Test-Command($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
$tarAvailable = Test-Command 'tar.exe'
$zstdBinaryAvailable = Test-Command 'zstd.exe'
# Windows backup archives are tar-based. gzip support is available through
# bsdtar's built-in -z mode on supported Windows OpenSSH hosts; a standalone
# gzip.exe is not required for ShellOrchestra backup runs.
$zstdAvailable = $tarAvailable -and $zstdBinaryAvailable
$gzipAvailable = $tarAvailable
$recommended = 'none'
if ($gzipAvailable) { $recommended = 'gzip' }
if ($zstdAvailable) { $recommended = 'zstd' }
$tarVersion = ''
$zstdVersion = ''
$gzipVersion = ''
if ($tarAvailable) { $tarVersion = 'tar.exe' }
if ($zstdBinaryAvailable) { $zstdVersion = 'zstd.exe' }
if ($gzipAvailable) { $gzipVersion = 'tar.exe -z' }
@{
  ok = $true
  tar_available = $tarAvailable
  zstd_available = $zstdAvailable
  gzip_available = $gzipAvailable
  recommended = $recommended
  tar_version = $tarVersion
  zstd_version = $zstdVersion
  gzip_version = $gzipVersion
} | ConvertTo-Json -Depth 8 -Compress
