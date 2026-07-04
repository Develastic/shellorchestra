# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'

function EnvValue([string]$Name, [string]$Default = '') {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ($null -eq $value) { return $Default }
  return [string]$value
}

$serviceName = (EnvValue 'SHELLORCHESTRA_SERVICE_NAME').Trim()
$serviceAction = (EnvValue 'SHELLORCHESTRA_SERVICE_ACTION').Trim().ToLowerInvariant()
$dryRun = (EnvValue 'SHELLORCHESTRA_DRY_RUN' '0').Trim()

function Assert-ServiceName([string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Name) -or $Name.Length -gt 256 -or $Name -notmatch '^[A-Za-z0-9_. :@-]+$') {
    throw 'Choose a safe Windows service name.'
  }
}

function ServicePayload([bool]$Ok, [string]$Message) {
  [ordered]@{
    ok = $Ok
    manager = 'windows-service-control'
    service = $serviceName
    action = $serviceAction
    message = $Message
  } | ConvertTo-Json -Depth 4 -Compress
}

Assert-ServiceName $serviceName
if ($serviceAction -notin @('start', 'stop', 'restart', 'reload')) { throw "Unsupported service action: $serviceAction" }
if ($serviceAction -eq 'reload') { throw 'Windows Service Control Manager does not support a safe generic reload action. Use Restart when the service owner documents that restart is appropriate.' }

$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if (-not $service) {
  $service = Get-Service -ErrorAction Stop | Where-Object { $_.Name -eq $serviceName } | Select-Object -First 1
}
if (-not $service) { throw "Windows service was not found: $serviceName" }

if ($dryRun -eq '1') {
  ServicePayload $true "Dry run accepted for $serviceAction on $serviceName."
  exit 0
}

switch ($serviceAction) {
  'start' {
    Start-Service -Name $serviceName -ErrorAction Stop
    ServicePayload $true "Windows service was started."
  }
  'stop' {
    Stop-Service -Name $serviceName -ErrorAction Stop
    ServicePayload $true "Windows service was stopped."
  }
  'restart' {
    Restart-Service -Name $serviceName -ErrorAction Stop
    ServicePayload $true "Windows service was restarted."
  }
}
