# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

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
    try {
        $process = [System.Diagnostics.Process]::Start($startInfo)
    } catch {
        throw "Could not start $FileName $Arguments`: $($_.Exception.Message)"
    }
    if (-not $process) { throw "Windows did not start a process for $FileName $Arguments." }
    if (-not $process.WaitForExit($TimeoutMilliseconds)) {
        try { $process.Kill() } catch { }
        throw "$FileName $Arguments did not finish within $([int]($TimeoutMilliseconds / 1000)) seconds."
    }
    return [ordered]@{
        exit_code = [int]$process.ExitCode
        stdout = ([string]$process.StandardOutput.ReadToEnd()).Trim()
        stderr = ([string]$process.StandardError.ReadToEnd()).Trim()
    }
}

function Get-ShellOrchestraWingetVersion($wingetPath) {
    if (-not $wingetPath) { return '' }
    $result = Invoke-ShellOrchestraProcess -FileName $wingetPath -Arguments '--version' -TimeoutMilliseconds 30000
    if ($result.exit_code -ne 0) {
        $detail = @($result.stderr, $result.stdout) | Where-Object { $_ } | Select-Object -First 1
        if (-not $detail) { $detail = "exit code $($result.exit_code)" }
        throw "winget --version failed: $detail"
    }
    return $result.stdout.Trim()
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

function Test-ShellOrchestraWingetSource {
    param([Parameter(Mandatory = $true)][string]$WingetPath)
    $probe = Invoke-ShellOrchestraProcess -FileName $WingetPath -Arguments 'search --source winget --id Microsoft.PowerShell --exact --accept-source-agreements' -TimeoutMilliseconds 120000
    return ($probe.exit_code -eq 0)
}

function Ensure-ShellOrchestraWingetSource {
    param([Parameter(Mandatory = $true)][string]$WingetPath)
    $repaired = Register-ShellOrchestraWingetSourceForCurrentUser
    if (Test-ShellOrchestraWingetSource -WingetPath $WingetPath) {
        return [ordered]@{ ready = $true; repaired = [bool]$repaired }
    }
    try { [void](Invoke-ShellOrchestraProcess -FileName $WingetPath -Arguments 'source update winget' -TimeoutMilliseconds 180000) } catch { }
    if (Test-ShellOrchestraWingetSource -WingetPath $WingetPath) {
        return [ordered]@{ ready = $true; repaired = $true }
    }
    throw "Microsoft winget is installed, but its package source is not ready for this Windows SSH account. ShellOrchestra tried to register Microsoft.Winget.Source for the current user and refresh the winget source. Sign in once as this Windows account or repair Microsoft App Installer/winget, then run detection again. Winget logs are in $env:LOCALAPPDATA\Packages\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe\LocalState\DiagOutputDir."
}

function Write-ShellOrchestraResult($initialized, $sourceRepaired, $wingetPath, $version) {
    [Console]::Out.Write((([ordered]@{
        ok = $true
        initialized = [bool]$initialized
        source_ready = $true
        source_repaired = [bool]$sourceRepaired
        package_manager = 'winget'
        winget_path = [string]$wingetPath
        winget_version = [string]$version
    }) | ConvertTo-Json -Compress))
}

$beforePath = Find-ShellOrchestraWinget
if ($beforePath) {
    $beforeVersion = Get-ShellOrchestraWingetVersion $beforePath
    $source = Ensure-ShellOrchestraWingetSource -WingetPath $beforePath
    Write-ShellOrchestraResult $false $source.repaired $beforePath $beforeVersion
    exit 0
}

if (-not $env:LOCALAPPDATA) {
    throw 'This Windows SSH account does not expose LOCALAPPDATA, so ShellOrchestra cannot register winget for it.'
}

$windowsApps = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'
if (-not (Test-Path -LiteralPath $windowsApps -PathType Container)) {
    throw "This Windows SSH account does not have a WindowsApps alias directory at $windowsApps."
}

Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe
Start-Sleep -Seconds 2

$afterPath = Find-ShellOrchestraWinget
if (-not $afterPath) {
    throw 'Microsoft App Installer registration completed, but winget is still not visible to this SSH account.'
}
$afterVersion = Get-ShellOrchestraWingetVersion $afterPath
$afterSource = Ensure-ShellOrchestraWingetSource -WingetPath $afterPath
Write-ShellOrchestraResult $true $afterSource.repaired $afterPath $afterVersion
