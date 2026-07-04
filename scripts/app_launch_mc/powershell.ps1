# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'

function Find-ShellOrchestraMC {
  $command = Get-Command mc -ErrorAction SilentlyContinue
  if ($command -and $command.Source) { return [string]$command.Source }
  $candidates = @()
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Midnight Commander\mc.exe') }
  $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  if ($programFilesX86) { $candidates += (Join-Path $programFilesX86 'Midnight Commander\mc.exe') }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Midnight Commander\mc.exe') }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
  }
  return ''
}

$mcPath = Find-ShellOrchestraMC
if (-not $mcPath) {
  [Console]::Error.WriteLine('Midnight Commander is not installed on this server. Install it from the ShellOrchestra desktop app list, then try again.')
  exit 127
}

$skinName = ''
if ($env:APPDATA) {
  $configFile = Join-Path (Join-Path $env:APPDATA 'Midnight Commander') 'ini'
  if (Test-Path -LiteralPath $configFile -PathType Leaf) {
    $skinLine = Get-Content -LiteralPath $configFile -ErrorAction SilentlyContinue | Where-Object { $_ -match '^skin\s*=' } | Select-Object -First 1
    if ($skinLine) {
      $skinName = ($skinLine -replace '^skin\s*=', '').Trim()
    }
  }
}

if ($skinName) {
  & $mcPath -S $skinName
} else {
  & $mcPath
}
exit $LASTEXITCODE
