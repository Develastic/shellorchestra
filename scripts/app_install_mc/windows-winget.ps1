# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$packageId = 'GNU.MidnightCommander'

if ($env:SHELLORCHESTRA_DRY_RUN -eq '1') {
  [Console]::Out.Write((([ordered]@{ ok = $true; dry_run = $true; manager = 'winget'; operation = 'install'; package = $packageId; app = 'mc' }) | ConvertTo-Json -Compress))
  exit 0
}

function Stop-ShellOrchestraInstall {
  param([Parameter(Mandatory = $true)][string]$Message)
  [Console]::Error.WriteLine($Message)
  exit 1
}

function Find-ShellOrchestraWinget {
  $command = Get-Command winget -ErrorAction SilentlyContinue
  if ($command -and $command.Source) { return [string]$command.Source }
  if ($env:LOCALAPPDATA) {
    $localAlias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
    if (Test-Path -LiteralPath $localAlias -PathType Leaf) { return $localAlias }
  }
  return ''
}

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

function Install-ShellOrchestraMCSkin {
  param([string]$MCPath = '')
  if ([string]::IsNullOrWhiteSpace($MCPath)) { $MCPath = Find-ShellOrchestraMC }
  if ([string]::IsNullOrWhiteSpace($MCPath)) {
    Stop-ShellOrchestraInstall 'Midnight Commander is installed according to winget, but ShellOrchestra could not locate mc.exe before configuring the theme.'
  }
  $installRoot = Split-Path -Parent $MCPath
  $baseSkin = Join-Path $installRoot 'share\skins\yadt256-defbg.ini'
  if (-not (Test-Path -LiteralPath $baseSkin -PathType Leaf)) {
    Stop-ShellOrchestraInstall "Midnight Commander is installed, but ShellOrchestra could not locate the bundled yadt256-defbg skin at '$baseSkin'."
  }
  $skinName = 'shellorchestra-yadt256-defbg'
  $skinText = [System.IO.File]::ReadAllText($baseSkin)
  $skinText = $skinText -replace '(?m)^\s*description\s*=.*$', '    description = ShellOrchestra yadt256 defbg, 256 colors'
  $skinText = $skinText -replace '(?m)^\s*selected\s*=.*$', '    selected = color16;color46'
  $skinText = $skinText -replace '(?m)^\s*markselect\s*=.*$', '    markselect = color16;color46;bold'
  $skinText = $skinText -replace '(?m)^\s*gauge\s*=.*$', '    gauge = color16;color46'
  $skinText = $skinText -replace '(?m)^\s*reverse\s*=.*$', '    reverse = color16;color46;bold'
  $skinText = $skinText -replace '(?m)^\s*header\s*=.*$', '    header = color46;;bold'
  $skinText = $skinText -replace '(?m)^\s*menusel\s*=.*$', '    menusel = color16;color46'
  $skinText = $skinText -replace '(?m)^\s*menuhotsel\s*=.*$', '    menuhotsel = color16;color46'
  $skinText = $skinText -replace '(?m)^\s*button\s*=.*$', '    button = color250;color236'
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $dataRoots = @()
  if ($env:LOCALAPPDATA) { $dataRoots += (Join-Path $env:LOCALAPPDATA 'Midnight Commander') }
  if ($env:APPDATA) { $dataRoots += (Join-Path $env:APPDATA 'Midnight Commander') }
  foreach ($dataRoot in $dataRoots) {
    $skinDir = Join-Path $dataRoot 'skins'
    New-Item -ItemType Directory -Force -Path $skinDir | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $skinDir ($skinName + '.ini')), $skinText, $utf8NoBom)
  }
  if (-not $env:APPDATA) { return }
  $configDir = Join-Path $env:APPDATA 'Midnight Commander'
  $configFile = Join-Path $configDir 'ini'
  New-Item -ItemType Directory -Force -Path $configDir | Out-Null
  $skinLine = "skin=$skinName"
  $editorLine = 'use_internal_edit=1'
  if (Test-Path -LiteralPath $configFile -PathType Leaf) {
    $content = Get-Content -LiteralPath $configFile -ErrorAction SilentlyContinue
    $hasSkin = $false
    $hasInternalEditor = $false
    $next = $content | ForEach-Object {
      if ($_ -match '^skin\s*=') {
        $hasSkin = $true
        $skinLine
      } elseif ($_ -match '^use_internal_edit\s*=') {
        $hasInternalEditor = $true
        $editorLine
      } else {
        $_
      }
    }
    $nextList = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $next) { $nextList.Add([string]$line) }
    if (-not $hasSkin) {
      $nextList.Add('')
      $nextList.Add('[Midnight-Commander]')
      $nextList.Add($skinLine)
    }
    if (-not $hasInternalEditor) {
      $nextList.Add('')
      $nextList.Add('[Midnight-Commander]')
      $nextList.Add($editorLine)
    }
    [System.IO.File]::WriteAllLines($configFile, [string[]]$nextList.ToArray(), $utf8NoBom)
    return
  }
  [System.IO.File]::AppendAllText($configFile, "`n[Midnight-Commander]`n$skinLine`n$editorLine`n", $utf8NoBom)
}

function Invoke-ShellOrchestraProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FileName,
    [Parameter(Mandatory = $true)][string]$Arguments,
    [int]$TimeoutMilliseconds = 120000
  )
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FileName
  $startInfo.Arguments = $Arguments
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  try {
    $process = [System.Diagnostics.Process]::Start($startInfo)
  } catch {
    Stop-ShellOrchestraInstall "Could not start Microsoft winget for this SSH login account: $($_.Exception.Message)."
  }
  if (-not $process) { Stop-ShellOrchestraInstall 'Microsoft winget exists, but Windows did not start a process for this SSH login account.' }
  if (-not $process.WaitForExit($TimeoutMilliseconds)) {
    try { $process.Kill() } catch { }
    Stop-ShellOrchestraInstall "Microsoft winget did not finish within $([int]($TimeoutMilliseconds / 1000)) seconds."
  }
  return [ordered]@{
    exit_code = [int]$process.ExitCode
    stdout = ([string]$process.StandardOutput.ReadToEnd()).Trim()
    stderr = ([string]$process.StandardError.ReadToEnd()).Trim()
  }
}

function Register-ShellOrchestraWingetSourceForCurrentUser {
  $current = Get-AppxPackage -Name Microsoft.Winget.Source -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($current) { return $false }
  $source = Get-AppxPackage -AllUsers -Name Microsoft.Winget.Source -ErrorAction SilentlyContinue | Sort-Object PackageFullName -Descending | Select-Object -First 1
  if (-not $source) { return $false }
  $manifest = Join-Path $source.InstallLocation 'AppxManifest.xml'
  if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return $false }
  Add-AppxPackage -Register $manifest -DisableDevelopmentMode
  return $true
}

function Assert-ShellOrchestraWingetReady {
  param([Parameter(Mandatory = $true)][string]$WingetPath)
  if ([string]::IsNullOrWhiteSpace($WingetPath)) {
    Stop-ShellOrchestraInstall 'Midnight Commander installation on Windows uses Microsoft winget only, but this SSH login account cannot see winget.'
  }
  if (-not (Test-Path -LiteralPath $WingetPath -PathType Leaf)) {
    Stop-ShellOrchestraInstall "Microsoft winget was detected at '$WingetPath', but that file is not available to this SSH login account."
  }
  $version = Invoke-ShellOrchestraProcess -FileName $WingetPath -Arguments '--version' -TimeoutMilliseconds 30000
  if ($version.exit_code -ne 0) {
    $detail = @($version.stderr, $version.stdout) | Where-Object { $_ } | Select-Object -First 1
    if (-not $detail) { $detail = "exit code $($version.exit_code)" }
    Stop-ShellOrchestraInstall "Microsoft winget exists, but this SSH login account cannot use it: $detail"
  }
  [void](Register-ShellOrchestraWingetSourceForCurrentUser)
  $search = Invoke-ShellOrchestraProcess -FileName $WingetPath -Arguments "search --source winget --id $packageId --exact --accept-source-agreements" -TimeoutMilliseconds 180000
  if ($search.exit_code -eq 0) { return }
  try { [void](Invoke-ShellOrchestraProcess -FileName $WingetPath -Arguments 'source update winget' -TimeoutMilliseconds 180000) } catch { }
  [void](Register-ShellOrchestraWingetSourceForCurrentUser)
  $retry = Invoke-ShellOrchestraProcess -FileName $WingetPath -Arguments "search --source winget --id $packageId --exact --accept-source-agreements" -TimeoutMilliseconds 180000
  if ($retry.exit_code -eq 0) { return }
  $detail = @($retry.stderr, $retry.stdout, $search.stderr, $search.stdout) | Where-Object { $_ } | Select-Object -First 1
  if (-not $detail) { $detail = "exit code $($retry.exit_code)" }
  Stop-ShellOrchestraInstall "Microsoft winget is installed, but its package source is not ready for this Windows SSH account. ShellOrchestra tried to register Microsoft.Winget.Source for this account and refresh the winget source. Sign in once as this Windows account or repair Microsoft App Installer/winget, then run detection again. Last winget message: $detail"
}

$wingetPath = Find-ShellOrchestraWinget
Assert-ShellOrchestraWingetReady -WingetPath $wingetPath
if ($env:SHELLORCHESTRA_PREFLIGHT_ONLY -eq '1') {
  [Console]::Out.Write((([ordered]@{ ok = $true; preflight = $true; manager = 'winget'; operation = 'install'; package = $packageId; app = 'mc' }) | ConvertTo-Json -Compress))
  exit 0
}
$existingMCPath = Find-ShellOrchestraMC
if ($existingMCPath) {
  Install-ShellOrchestraMCSkin -MCPath $existingMCPath
  [Console]::Out.Write((([ordered]@{ ok = $true; manager = 'winget'; operation = 'install'; package = $packageId; app = 'mc'; executable = $existingMCPath; already_installed = $true }) | ConvertTo-Json -Compress))
  exit 0
}
$install = Invoke-ShellOrchestraProcess -FileName $wingetPath -Arguments "install --source winget --id $packageId --exact --accept-source-agreements --accept-package-agreements --disable-interactivity" -TimeoutMilliseconds 900000
if ($install.exit_code -ne 0) {
  $mcAfterFailedInstall = Find-ShellOrchestraMC
  if ($mcAfterFailedInstall) {
    Install-ShellOrchestraMCSkin -MCPath $mcAfterFailedInstall
    [Console]::Out.Write((([ordered]@{ ok = $true; manager = 'winget'; operation = 'install'; package = $packageId; app = 'mc'; executable = $mcAfterFailedInstall; already_installed = $true }) | ConvertTo-Json -Compress))
    exit 0
  }
  $detail = @($install.stderr, $install.stdout) | Where-Object { $_ } | Select-Object -First 1
  if (-not $detail) { $detail = "exit code $($install.exit_code)" }
  Stop-ShellOrchestraInstall "winget could not install Midnight Commander: $detail"
}
$mcPath = Find-ShellOrchestraMC
if (-not $mcPath) {
  Stop-ShellOrchestraInstall 'winget reported that Midnight Commander was installed, but ShellOrchestra could not find mc.exe in the standard installation locations.'
}
Install-ShellOrchestraMCSkin -MCPath $mcPath
[Console]::Out.Write((([ordered]@{ ok = $true; manager = 'winget'; operation = 'install'; package = $packageId; app = 'mc'; executable = $mcPath }) | ConvertTo-Json -Compress))
