# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
[int]$pidValue = 0
if (-not [int]::TryParse($env:SHELLORCHESTRA_PROCESS_PID, [ref]$pidValue) -or $pidValue -le 1) { throw 'A numeric process id greater than 1 is required.' }
$signal = if ($env:SHELLORCHESTRA_PROCESS_SIGNAL) { $env:SHELLORCHESTRA_PROCESS_SIGNAL } else { 'TERM' }
if ($signal -eq 'KILL') { Stop-Process -Id $pidValue -Force -ErrorAction Stop } else { Stop-Process -Id $pidValue -ErrorAction Stop }
[ordered]@{ ok = $true; pid = $pidValue; signal = $signal } | ConvertTo-Json -Compress
