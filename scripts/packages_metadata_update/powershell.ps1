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
    [int]$TimeoutMilliseconds = 900000
  )
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FileName
  $startInfo.Arguments = $Arguments
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true
  try { $process = [System.Diagnostics.Process]::Start($startInfo) } catch { Stop-ShellOrchestraWingetAction "Could not start Microsoft winget for this SSH login account: $($_.Exception.Message)." }
  if (-not $process) { Stop-ShellOrchestraWingetAction 'Microsoft winget exists, but Windows did not start a process for this SSH login account.' }
  try {
    if (-not $process.WaitForExit($TimeoutMilliseconds)) {
      try { $process.Kill($true) } catch { try { $process.Kill() } catch { } }
      Stop-ShellOrchestraWingetAction "Microsoft winget source update did not finish within $([int]($TimeoutMilliseconds / 1000)) seconds."
    }
    $stdout = ([string]$process.StandardOutput.ReadToEnd()).Trim()
    $stderr = ([string]$process.StandardError.ReadToEnd()).Trim()
    return [ordered]@{ exit_code = [int]$process.ExitCode; stdout = $stdout; stderr = $stderr }
  } finally {
    $process.Dispose()
  }
}

$manager = if ($env:SHELLORCHESTRA_PACKAGE_MANAGER -and $env:SHELLORCHESTRA_PACKAGE_MANAGER -ne 'auto') { $env:SHELLORCHESTRA_PACKAGE_MANAGER } else { 'winget' }
if ($env:SHELLORCHESTRA_DRY_RUN -eq '1' -or $env:SHELLORCHESTRA_CONFIRMED -ne '1') {
  [Console]::Out.Write((([ordered]@{ ok = $true; dry_run = $true; manager = $manager; operation = 'metadata_update' }) | ConvertTo-Json -Compress))
  exit 0
}
if ($manager -ne 'winget') { Stop-ShellOrchestraWingetAction 'Windows package metadata update supports Microsoft winget only.' }
$wingetPath = Find-ShellOrchestraWinget
if (-not $wingetPath) { Stop-ShellOrchestraWingetAction 'Microsoft winget is not available to this SSH login account.' }
$result = Invoke-ShellOrchestraProcess -FileName $wingetPath -Arguments 'source update --source winget --disable-interactivity'
if ($result.exit_code -ne 0) {
  $detail = @($result.stderr, $result.stdout) | Where-Object { $_ } | Select-Object -First 1
  if (-not $detail) { $detail = "exit code $($result.exit_code)" }
  Stop-ShellOrchestraWingetAction "winget source update failed: $detail"
}
$preview = @($result.stdout, $result.stderr) | Where-Object { $_ } | Select-Object -First 1
[Console]::Out.Write((([ordered]@{ ok = $true; manager = 'winget'; operation = 'metadata_update'; output_preview = [string]$preview }) | ConvertTo-Json -Compress))
