# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
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
  try { $process = [System.Diagnostics.Process]::Start($startInfo) } catch { Stop-ShellOrchestraWingetAction "Could not start Microsoft winget for this SSH login account: $($_.Exception.Message)." }
  if (-not $process) { Stop-ShellOrchestraWingetAction 'Microsoft winget exists, but Windows did not start a process for this SSH login account.' }
  if (-not $process.WaitForExit($TimeoutMilliseconds)) {
    try { $process.Kill() } catch { }
    Stop-ShellOrchestraWingetAction "Microsoft winget did not finish within $([int]($TimeoutMilliseconds / 1000)) seconds."
  }
  return [ordered]@{ exit_code = [int]$process.ExitCode; stdout = ([string]$process.StandardOutput.ReadToEnd()).Trim(); stderr = ([string]$process.StandardError.ReadToEnd()).Trim() }
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

function New-ShellOrchestraUpgradeResult {
  param(
    [Parameter(Mandatory = $true)][string]$Manager,
    [Parameter(Mandatory = $true)][string]$Output
  )
  $lines = @($Output -split "`r?`n" | Where-Object { $_ -ne $null })
  $preview = ($lines | Select-Object -Last 80) -join "`n"
  $updatedNames = New-Object System.Collections.Generic.List[string]
  foreach ($line in $lines) {
    if ($line -match '^\s*([\w][^\s]{1,80})\s+\S+\s+\S+\s+winget\s*$') {
      [void]$updatedNames.Add($Matches[1])
    }
  }
  $uniqueNames = @($updatedNames | Select-Object -Unique)
  $updatedCount = $null
  if ($uniqueNames.Count -gt 0) { $updatedCount = [int]$uniqueNames.Count }
  [ordered]@{
    ok = $true
    manager = $Manager
    updated_count = $updatedCount
    updated_packages = $uniqueNames
    output_preview = $preview
  } | ConvertTo-Json -Compress
}

function Assert-ShellOrchestraWingetReady {
  param([Parameter(Mandatory = $true)][string]$WingetPath)
  if ([string]::IsNullOrWhiteSpace($WingetPath)) { Stop-ShellOrchestraWingetAction 'Windows package management in ShellOrchestra uses Microsoft winget only, but this SSH login account cannot see winget.' }
  if (-not (Test-Path -LiteralPath $WingetPath -PathType Leaf)) { Stop-ShellOrchestraWingetAction "Microsoft winget was detected at '$WingetPath', but that file is not available to this SSH login account." }
  $version = Invoke-ShellOrchestraProcess -FileName $WingetPath -Arguments '--version' -TimeoutMilliseconds 30000
  if ($version.exit_code -ne 0) {
    $detail = @($version.stderr, $version.stdout) | Where-Object { $_ } | Select-Object -First 1
    if (-not $detail) { $detail = "exit code $($version.exit_code)" }
    Stop-ShellOrchestraWingetAction "Microsoft winget exists, but this SSH login account cannot use it: $detail"
  }
  [void](Register-ShellOrchestraWingetSourceForCurrentUser)
}
function Invoke-ShellOrchestraWingetAction {
  param(
    [Parameter(Mandatory = $true)][string]$WingetPath,
    [Parameter(Mandatory = $true)][string]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailurePrefix
  )
  $result = Invoke-ShellOrchestraProcess -FileName $WingetPath -Arguments $Arguments -TimeoutMilliseconds 900000
  if ($result.exit_code -ne 0) {
    $detail = @($result.stderr, $result.stdout) | Where-Object { $_ } | Select-Object -First 1
    if (-not $detail) { $detail = "exit code $($result.exit_code)" }
    Stop-ShellOrchestraWingetAction "$FailurePrefix`: $detail"
  }
  return (@($result.stdout, $result.stderr) | Where-Object { $_ }) -join "`n"
}
if ($env:SHELLORCHESTRA_DRY_RUN -eq "1" -or $env:SHELLORCHESTRA_CONFIRMED -ne "1") {
    [Console]::Out.Write('{"ok":true,"manager":"winget","dry_run":true}')
    exit 0
}
$wingetPath = Find-ShellOrchestraWinget
Assert-ShellOrchestraWingetReady -WingetPath $wingetPath
$upgradeOutput = Invoke-ShellOrchestraWingetAction -WingetPath $wingetPath -Arguments 'upgrade --all --source winget --accept-source-agreements --accept-package-agreements --disable-interactivity' -FailurePrefix 'winget could not upgrade packages'
[Console]::Out.Write((New-ShellOrchestraUpgradeResult -Manager 'winget' -Output $upgradeOutput))
