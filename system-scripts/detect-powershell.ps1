# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$distro = ""
$releasePath = "C:\ProgramData\ShellOrchestra\os-release"
if (Test-Path $releasePath) {
    $line = Get-Content $releasePath | Where-Object { $_ -match "^ID=" } | Select-Object -First 1
    if ($line) { $distro = ($line -replace "^ID=", "").Trim('"').ToLowerInvariant() }
}
$admin = "none"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { $admin = "administrator" }
$hostname = ""
try {
    $hostname = [System.Net.Dns]::GetHostName()
} catch {
    $hostname = ""
}
$hostname = ($hostname -replace "[^A-Za-z0-9_.-]", "").ToLowerInvariant()
if ([string]::IsNullOrWhiteSpace($hostname)) { $hostname = "unknown" }
$arch = try { (Get-CimInstance Win32_OperatingSystem).OSArchitecture } catch { [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() }
$arch = ($arch -replace "[^A-Za-z0-9_. -]", "").Trim().ToLowerInvariant()
if ([string]::IsNullOrWhiteSpace($arch)) { $arch = "unknown" }
$kernelVersion = try { [System.Environment]::OSVersion.VersionString } catch { "unknown" }
function Get-ShellOrchestraSSHMaxSessions {
    $sshd = Get-Command sshd.exe -ErrorAction SilentlyContinue
    if (-not $sshd -or -not $sshd.Source) { return 0 }
    try {
        $lines = & $sshd.Source -T 2>$null
        foreach ($line in $lines) {
            if ($line -match '^\s*maxsessions\s+([0-9]+)\s*$') {
                return [int]$Matches[1]
            }
        }
    } catch {
    }
    $configCandidates = @()
    if ($env:ProgramData) { $configCandidates += (Join-Path $env:ProgramData 'ssh\sshd_config') }
    $configCandidates += 'C:\ProgramData\ssh\sshd_config'
    foreach ($configPath in ($configCandidates | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { continue }
        try {
            foreach ($line in (Get-Content -LiteralPath $configPath -ErrorAction Stop)) {
                $trimmed = ([string]$line).Trim()
                if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith('#')) { continue }
                if ($trimmed -match '(?i)^Match\s+') { break }
                if ($trimmed -match '(?i)^MaxSessions\s+([0-9]+)\s*$') {
                    return [int]$Matches[1]
                }
            }
        } catch {
        }
    }
    return 10
}
function Find-ShellOrchestraWinget {
    if ($env:LOCALAPPDATA) {
        $localAlias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
        if (Test-Path -LiteralPath $localAlias -PathType Leaf) {
            return $localAlias
        }
    }
    return ''
}
function Test-ShellOrchestraDesktopAppInstallerAvailable {
    try {
        $currentPackage = Get-AppxPackage -Name Microsoft.DesktopAppInstaller -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($currentPackage) { return $true }
    } catch {
    }
    try {
        $allUsersPackage = Get-AppxPackage -AllUsers -Name Microsoft.DesktopAppInstaller -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($allUsersPackage) { return $true }
    } catch {
    }
    try {
        $provisionedPackage = Get-AppxProvisionedPackage -Online -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'Microsoft.DesktopAppInstaller' } | Select-Object -First 1
        if ($provisionedPackage) { return $true }
    } catch {
    }
    return $false
}
function Test-ShellOrchestraWingetSourceRegistered {
    try {
        $currentSource = Get-AppxPackage -Name Microsoft.Winget.Source -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($currentSource) { return $true }
    } catch {
    }
    return $false
}
function Test-ShellOrchestraWingetSourceAvailableForRegistration {
    try {
        $allUsersSource = Get-AppxPackage -AllUsers -Name Microsoft.Winget.Source -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($allUsersSource) { return $true }
    } catch {
    }
    return $false
}
function Test-ShellOrchestraWingetNeedsInitialization {
    if (Find-ShellOrchestraWinget) {
        if (Test-ShellOrchestraWingetSourceRegistered) { return $false }
        return [bool](Test-ShellOrchestraWingetSourceAvailableForRegistration)
    }
    if (-not $env:LOCALAPPDATA) { return $false }
    $windowsApps = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'
    if (-not (Test-Path -LiteralPath $windowsApps -PathType Container)) { return $false }
    return [bool](Test-ShellOrchestraDesktopAppInstallerAvailable)
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
$wingetPath = Find-ShellOrchestraWinget
$wingetNeedsInitialization = Test-ShellOrchestraWingetNeedsInitialization
$packageManager = if ($wingetPath) { "winget" } else { "windows-registry" }
$sshMaxSessions = Get-ShellOrchestraSSHMaxSessions
$dockerHost = $false
if ((Get-Command docker -ErrorAction SilentlyContinue) -or (Get-Command podman -ErrorAction SilentlyContinue)) {
    $dockerHost = $true
}
$podmanHost = [bool](Get-Command podman -ErrorAction SilentlyContinue)
$virtualization = 'unknown'
try {
    $computerSystem = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
    $model = [string]$computerSystem.Model
    $manufacturer = [string]$computerSystem.Manufacturer
    $hypervisorPresent = $false
    if ($null -ne $computerSystem.PSObject.Properties['HypervisorPresent']) {
        $hypervisorPresent = [bool]$computerSystem.HypervisorPresent
    }
    if ($hypervisorPresent -or $model -match '(?i)(virtual|vmware|kvm|qemu|hyper-v|virtualbox|bhyve)' -or $manufacturer -match '(?i)(vmware|qemu|microsoft corporation|xen|parallels)') {
        $virtualization = 'virtual-machine'
    } else {
        $virtualization = 'physical'
    }
} catch {
    $virtualization = 'unknown'
}
$apps = @{
    mc = [bool](Find-ShellOrchestraMC)
    htop = [bool](Get-Command htop -ErrorAction SilentlyContinue)
    btop = [bool](Get-Command btop -ErrorAction SilentlyContinue)
    docker = [bool](Get-Command docker -ErrorAction SilentlyContinue)
    podman = [bool](Get-Command podman -ErrorAction SilentlyContinue)
    lazydocker = [bool](Get-Command lazydocker -ErrorAction SilentlyContinue)
    speedtest = [bool]((Get-Command speedtest -ErrorAction SilentlyContinue) -or (Get-Command speedtest-cli -ErrorAction SilentlyContinue))
}
[Console]::Out.Write((@{
    hostname = $hostname
    shell = "powershell"
    os = "windows"
    platform_os = "windows"
    platform_arch = $arch
    platform = "windows $arch"
    distro = $distro
    admin_rights = $admin
    kernel_version = $kernelVersion
    package_manager = $packageManager
    ssh_max_sessions = $sshMaxSessions
    virtualization = $virtualization
    winget_needs_initialization = $wingetNeedsInitialization
    is_pve_host = $false
    is_docker_host = $dockerHost
    is_podman_host = $podmanHost
    apps = $apps
} | ConvertTo-Json -Compress))
