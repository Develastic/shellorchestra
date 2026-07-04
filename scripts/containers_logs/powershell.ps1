# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$containerID = if ($env:SHELLORCHESTRA_CONTAINER_ID) { [string]$env:SHELLORCHESTRA_CONTAINER_ID } else { '' }
$action = if ($env:SHELLORCHESTRA_CONTAINER_ACTION) { [string]$env:SHELLORCHESTRA_CONTAINER_ACTION } else { 'logs' }
$engine = if ($env:SHELLORCHESTRA_CONTAINER_ENGINE -and $env:SHELLORCHESTRA_CONTAINER_ENGINE -ne 'auto') { [string]$env:SHELLORCHESTRA_CONTAINER_ENGINE } else { '' }
$tailLines = 300
[int]::TryParse($env:SHELLORCHESTRA_CONTAINER_LOGS_TAIL, [ref]$tailLines) | Out-Null
if ($tailLines -lt 1) { $tailLines = 1 }
if ($tailLines -gt 5000) { $tailLines = 5000 }
if ($containerID -notmatch '^[A-Za-z0-9_.:-]{1,128}$') { throw 'A safe container id or name is required.' }
if ($action -ne 'logs') { throw "Unsupported container action: $action" }
function Limit-ShellOrchestraOutputLog {
  param([string]$Value)
  $limit = 120000
  if ($Value.Length -gt $limit) {
    return [ordered]@{
      text = $Value.Substring(0, $limit) + [Environment]::NewLine + "... output truncated by ShellOrchestra after $limit characters ..."
      truncated = $true
    }
  }
  return [ordered]@{ text = $Value; truncated = $false }
}
if (-not $engine) {
  if (Get-Command docker -ErrorAction SilentlyContinue) { $engine = 'docker' }
  elseif (Get-Command podman -ErrorAction SilentlyContinue) { $engine = 'podman' }
  else { throw 'Docker or Podman is required for container logs.' }
}
if ($engine -notin @('docker','podman')) { throw "Unsupported container engine: $engine" }
& $engine inspect $containerID | Out-Null
$output = & $engine logs --timestamps --tail $tailLines $containerID 2>&1
$nativeExitCode = if ($null -eq $global:LASTEXITCODE) { 0 } else { [int]$global:LASTEXITCODE }
$outputText = ($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
if ($nativeExitCode -ne 0) {
  if ($outputText) { [Console]::Error.WriteLine($outputText) }
  exit $nativeExitCode
}
if ([string]::IsNullOrWhiteSpace($outputText)) {
  $outputText = 'The selected container returned no stdout/stderr log lines for the requested tail range.'
}
$limited = Limit-ShellOrchestraOutputLog -Value $outputText
[ordered]@{ ok=$true; engine=$engine; container_id=$containerID; action='logs'; tail_lines=$tailLines; output_log=$limited.text; output_log_truncated=$limited.truncated } | ConvertTo-Json -Compress -Depth 4
