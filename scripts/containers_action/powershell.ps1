# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$containerID = if ($env:SHELLORCHESTRA_CONTAINER_ID) { [string]$env:SHELLORCHESTRA_CONTAINER_ID } else { '' }
$action = if ($env:SHELLORCHESTRA_CONTAINER_ACTION) { [string]$env:SHELLORCHESTRA_CONTAINER_ACTION } else { '' }
$engine = if ($env:SHELLORCHESTRA_CONTAINER_ENGINE -and $env:SHELLORCHESTRA_CONTAINER_ENGINE -ne 'auto') { [string]$env:SHELLORCHESTRA_CONTAINER_ENGINE } else { '' }
$dryRun = $env:SHELLORCHESTRA_DRY_RUN -in @('1', 'true', 'TRUE')
if ($containerID -notmatch '^[A-Za-z0-9_.:-]{1,128}$') { throw 'A safe container id or name is required.' }
if ($action -notin @('start','stop','restart')) { throw "Unsupported container action: $action" }
function Limit-ShellOrchestraOutputLog {
  param([string]$Value)
  $limit = 12000
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
  else { throw 'Docker or Podman is required for container actions.' }
}
if ($engine -notin @('docker','podman')) { throw "Unsupported container engine: $engine" }
& $engine inspect $containerID | Out-Null
if ($dryRun) {
  $previewLog = @(
    'Preview passed.'
    "Engine: $engine"
    "Container: $containerID"
    "Action: $action"
    'Container inspect succeeded.'
    'No container state was changed.'
  ) -join [Environment]::NewLine
  [ordered]@{ ok=$true; dry_run=$true; engine=$engine; container_id=$containerID; action=$action; message="Preview passed. ShellOrchestra can access the selected container with $engine. No container state was changed."; output_log=$previewLog; output_log_truncated=$false } | ConvertTo-Json -Compress -Depth 4
  exit 0
}
$output = & $engine $action $containerID 2>&1
$nativeExitCode = if ($null -eq $global:LASTEXITCODE) { 0 } else { [int]$global:LASTEXITCODE }
$outputText = ($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
if ($nativeExitCode -ne 0) {
  if ($outputText) { [Console]::Error.WriteLine($outputText) }
  exit $nativeExitCode
}
if ([string]::IsNullOrWhiteSpace($outputText)) {
  $outputText = "$engine $action $containerID completed successfully. The container engine returned no stdout/stderr output."
}
$limited = Limit-ShellOrchestraOutputLog -Value $outputText
[ordered]@{ ok=$true; dry_run=$false; engine=$engine; container_id=$containerID; action=$action; output_log=$limited.text; output_log_truncated=$limited.truncated } | ConvertTo-Json -Compress -Depth 4
