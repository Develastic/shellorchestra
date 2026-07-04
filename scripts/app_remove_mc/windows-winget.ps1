# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$packageId = 'GNU.MidnightCommander'

function Stop-ShellOrchestraWingetAction {
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
    Stop-ShellOrchestraWingetAction "Could not start Microsoft winget for this SSH login account: $($_.Exception.Message)."
  }
  if (-not $process) { Stop-ShellOrchestraWingetAction 'Microsoft winget exists, but Windows did not start a process for this SSH login account.' }
  if (-not $process.WaitForExit($TimeoutMilliseconds)) {
    try { $process.Kill() } catch { }
    Stop-ShellOrchestraWingetAction "Microsoft winget did not finish within $([int]($TimeoutMilliseconds / 1000)) seconds."
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
    Stop-ShellOrchestraWingetAction 'Midnight Commander removal on Windows requires Microsoft winget, but this SSH login account cannot see winget.'
  }
  if (-not (Test-Path -LiteralPath $WingetPath -PathType Leaf)) {
    Stop-ShellOrchestraWingetAction "Microsoft winget was detected at '$WingetPath', but that file is not available to this SSH login account."
  }
  $version = Invoke-ShellOrchestraProcess -FileName $WingetPath -Arguments '--version' -TimeoutMilliseconds 30000
  if ($version.exit_code -ne 0) {
    $detail = @($version.stderr, $version.stdout) | Where-Object { $_ } | Select-Object -First 1
    if (-not $detail) { $detail = "exit code $($version.exit_code)" }
    Stop-ShellOrchestraWingetAction "Microsoft winget exists, but this SSH login account cannot use it: $detail"
  }
  [void](Register-ShellOrchestraWingetSourceForCurrentUser)
}

if ($env:SHELLORCHESTRA_DRY_RUN -eq '1') {
  [Console]::Out.Write((([ordered]@{ ok = $true; dry_run = $true; manager = 'winget'; operation = 'remove'; package = $packageId; app = 'mc' }) | ConvertTo-Json -Compress))
  exit 0
}
$wingetPath = Find-ShellOrchestraWinget
Assert-ShellOrchestraWingetReady -WingetPath $wingetPath
if ($env:SHELLORCHESTRA_PREFLIGHT_ONLY -eq '1') {
  [Console]::Out.Write((([ordered]@{ ok = $true; preflight = $true; manager = 'winget'; operation = 'remove'; package = $packageId; app = 'mc' }) | ConvertTo-Json -Compress))
  exit 0
}
$existingMCPath = Find-ShellOrchestraMC
if (-not $existingMCPath) {
  [Console]::Out.Write((([ordered]@{ ok = $true; manager = 'winget'; operation = 'remove'; package = $packageId; app = 'mc'; already_absent = $true }) | ConvertTo-Json -Compress))
  exit 0
}
$remove = Invoke-ShellOrchestraProcess -FileName $wingetPath -Arguments "uninstall --source winget --id $packageId --exact --disable-interactivity" -TimeoutMilliseconds 900000
if ($remove.exit_code -ne 0) {
  $mcAfterFailedRemove = Find-ShellOrchestraMC
  if (-not $mcAfterFailedRemove) {
    [Console]::Out.Write((([ordered]@{ ok = $true; manager = 'winget'; operation = 'remove'; package = $packageId; app = 'mc'; already_absent = $true }) | ConvertTo-Json -Compress))
    exit 0
  }
  $detail = @($remove.stderr, $remove.stdout) | Where-Object { $_ } | Select-Object -First 1
  if (-not $detail) { $detail = "exit code $($remove.exit_code)" }
  Stop-ShellOrchestraWingetAction "winget could not remove Midnight Commander: $detail"
}
[Console]::Out.Write((([ordered]@{ ok = $true; manager = 'winget'; operation = 'remove'; package = $packageId; app = 'mc' }) | ConvertTo-Json -Compress))
