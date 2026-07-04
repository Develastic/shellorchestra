# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'

$commandText = [string]$env:SHELLORCHESTRA_CUSTOM_COMMAND
if ([string]::IsNullOrWhiteSpace($commandText)) {
  [Console]::Error.WriteLine('Custom shortcut command is empty.')
  exit 64
}

Clear-Host
Write-Output 'ShellOrchestra custom shortcut'
Write-Output ("Command: {0}" -f $commandText)
Write-Output ''
$exitCode = 0
try {
  Invoke-Expression $commandText
  if ($global:LASTEXITCODE -ne $null) { $exitCode = [int]$global:LASTEXITCODE }
} catch {
  $exitCode = 1
  [Console]::Error.WriteLine($_.Exception.Message)
}
Write-Output ''
Write-Output ("ShellOrchestra: custom shortcut finished with status {0}. Opening interactive PowerShell session." -f $exitCode)
powershell.exe -NoLogo
exit $exitCode
