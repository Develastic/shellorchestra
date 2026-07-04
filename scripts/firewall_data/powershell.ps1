# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$shellOrchestraOutputEncoding = if ($env:SHELLORCHESTRA_FIREWALL_OUTPUT_ENCODING) { $env:SHELLORCHESTRA_FIREWALL_OUTPUT_ENCODING.ToLowerInvariant() } else { '' }
$streamFormat = if ($env:SHELLORCHESTRA_FIREWALL_STREAM_FORMAT) { $env:SHELLORCHESTRA_FIREWALL_STREAM_FORMAT.ToLowerInvariant() } else { 'json' }
if ($shellOrchestraOutputEncoding -and $shellOrchestraOutputEncoding -notin @('auto', 'gzip')) { throw "Unsupported ShellOrchestra firewall output encoding: $shellOrchestraOutputEncoding" }
if (-not $streamFormat) { $streamFormat = 'json' }
if ($streamFormat -notin @('json', 'row_events')) { throw "Unsupported ShellOrchestra firewall stream format: $streamFormat" }

function Write-ShellOrchestraFirewallPayload([string]$payload) {
  $effectiveEncoding = $shellOrchestraOutputEncoding
  if ($effectiveEncoding -eq 'auto') { $effectiveEncoding = 'gzip' }
  $stdout = [Console]::OpenStandardOutput()
  if ($effectiveEncoding -eq 'gzip') {
    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $memory = New-Object System.IO.MemoryStream
    $gzip = New-Object System.IO.Compression.GzipStream -ArgumentList $memory, ([System.IO.Compression.CompressionMode]::Compress), $true
    try { $gzip.Write($bytes, 0, $bytes.Length) } finally { $gzip.Dispose() }
    $compressed = $memory.ToArray()
    $memory.Dispose()
    $stdout.Write($compressed, 0, $compressed.Length)
    $stdout.Flush()
    return
  }
  $plain = [Text.Encoding]::UTF8.GetBytes($payload)
  $stdout.Write($plain, 0, $plain.Length)
  $stdout.Flush()
}

function ConvertTo-ShellOrchestraJSONLine($value) {
  return (($value | ConvertTo-Json -Compress -Depth 8) + "`n")
}

if (-not (Get-Command Get-NetFirewallProfile -ErrorAction SilentlyContinue) -or -not (Get-Command netsh.exe -ErrorAction SilentlyContinue)) {
  $payload = [ordered]@{
    generated_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    manager = 'unknown'
    status_text = 'Windows firewall status tools were not found for this SSH account.'
    rules_text = ''
  }
  if ($streamFormat -eq 'row_events') {
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'meta'; data = $payload })))
    [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'done'; data = $payload })))
    Write-ShellOrchestraFirewallPayload $builder.ToString()
  } else {
    Write-ShellOrchestraFirewallPayload (($payload | ConvertTo-Json -Compress -Depth 4) + "`n")
  }
  exit 0
}

$profiles = @(Get-NetFirewallProfile -ErrorAction SilentlyContinue | ForEach-Object {
  "Profile: $($_.Name)`n  Enabled: $($_.Enabled)`n  DefaultInboundAction: $($_.DefaultInboundAction)`n  DefaultOutboundAction: $($_.DefaultOutboundAction)"
})
function Convert-NetshInboundRules {
  $rows = New-Object System.Collections.Generic.List[string]
  $current = @{}
  function Flush-Rule {
    if (-not $current.ContainsKey('RuleName')) { return }
    $enabled = if ($current.ContainsKey('Enabled')) { [string]$current['Enabled'] } else { '' }
    $direction = if ($current.ContainsKey('Direction')) { [string]$current['Direction'] } else { '' }
    if ($enabled -notmatch '^(?i:yes|true)$' -or $direction -notmatch '^(?i:in)$') { return }
    $name = [string]$current['RuleName']
    $action = if ($current.ContainsKey('Action')) { [string]$current['Action'] } else { 'Unknown' }
    $protocol = if ($current.ContainsKey('Protocol')) { [string]$current['Protocol'] } else { 'Any' }
    $port = if ($current.ContainsKey('LocalPort')) { [string]$current['LocalPort'] } else { 'Any' }
    $rows.Add("$name [$action] $protocol $port In") | Out-Null
  }
  foreach ($line in (& netsh.exe advfirewall firewall show rule name=all dir=in 2>&1)) {
    $text = [string]$line
    if ($text -match '^\s*Rule Name:\s*(.+?)\s*$') {
      Flush-Rule
      $current = @{ RuleName = $Matches[1] }
      continue
    }
    if ($text -match '^\s*([^:]+):\s*(.*?)\s*$') {
      $key = ($Matches[1] -replace '\s+', '')
      $current[$key] = $Matches[2]
    }
  }
  Flush-Rule
  return @($rows | Select-Object -First 80)
}
$rules = @(Convert-NetshInboundRules)
$payload = [ordered]@{
  generated_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  manager = 'windows_netsecurity'
  status_text = ($profiles -join "`n`n")
  rules_text = ($rules -join "`n")
}
if ($streamFormat -eq 'row_events') {
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'meta'; data = [ordered]@{ generated_at = $payload.generated_at; manager = $payload.manager; status_text = $payload.status_text } })))
  foreach ($rule in @($rules)) {
    [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'row'; data = [ordered]@{ raw = [string]$rule } })))
  }
  [void]$builder.Append((ConvertTo-ShellOrchestraJSONLine ([ordered]@{ event = 'done'; data = [ordered]@{ generated_at = $payload.generated_at; manager = $payload.manager; status_text = $payload.status_text } })))
  Write-ShellOrchestraFirewallPayload $builder.ToString()
  exit 0
}
Write-ShellOrchestraFirewallPayload (($payload | ConvertTo-Json -Compress -Depth 4) + "`n")
