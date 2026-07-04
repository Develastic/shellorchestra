# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$arch = try { (Get-CimInstance Win32_OperatingSystem).OSArchitecture } catch { [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() }
$arch = ($arch -replace "[^A-Za-z0-9_. -]", "").Trim().ToLowerInvariant()
if ([string]::IsNullOrWhiteSpace($arch)) { $arch = "unknown" }
$admin = "none"
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { $admin = "administrator" }
} catch {
    $admin = "none"
}
[Console]::Out.Write((@{
    shell = "powershell"
    os = "windows"
    platform_os = "windows"
    platform_arch = $arch
    platform = "windows $arch"
    admin_rights = $admin
} | ConvertTo-Json -Compress))
