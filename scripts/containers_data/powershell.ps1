# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$limit = 200
[int]::TryParse($env:SHELLORCHESTRA_CONTAINERS_LIMIT, [ref]$limit) | Out-Null
if ($limit -lt 1) { $limit = 1 }
if ($limit -gt 1000) { $limit = 1000 }
$query = if ($env:SHELLORCHESTRA_CONTAINERS_QUERY) { [string]$env:SHELLORCHESTRA_CONTAINERS_QUERY } else { '' }
$knownStateToken = if ($env:SHELLORCHESTRA_CONTAINERS_KNOWN_STATE_TOKEN -and $env:SHELLORCHESTRA_CONTAINERS_KNOWN_STATE_TOKEN -match '^[A-Za-z0-9_.:-]{1,160}$') { [string]$env:SHELLORCHESTRA_CONTAINERS_KNOWN_STATE_TOKEN } else { '' }
$shellOrchestraOutputEncoding = if ($env:SHELLORCHESTRA_CONTAINERS_OUTPUT_ENCODING) { $env:SHELLORCHESTRA_CONTAINERS_OUTPUT_ENCODING.ToLowerInvariant() } else { '' }
$streamFormat = if ($env:SHELLORCHESTRA_CONTAINERS_STREAM_FORMAT) { $env:SHELLORCHESTRA_CONTAINERS_STREAM_FORMAT.ToLowerInvariant() } else { 'json' }
if ($shellOrchestraOutputEncoding -and $shellOrchestraOutputEncoding -notin @('auto', 'gzip')) { throw "Unsupported ShellOrchestra containers output encoding: $shellOrchestraOutputEncoding" }
if (-not $streamFormat) { $streamFormat = 'json' }
if ($streamFormat -notin @('json', 'row_events')) { throw "Unsupported ShellOrchestra containers stream format: $streamFormat" }
$engine = if ($env:SHELLORCHESTRA_CONTAINER_ENGINE -and $env:SHELLORCHESTRA_CONTAINER_ENGINE -ne 'auto') { [string]$env:SHELLORCHESTRA_CONTAINER_ENGINE } else { '' }
if (-not $engine) {
  if (Get-Command docker -ErrorAction SilentlyContinue) { $engine = 'docker' }
  elseif (Get-Command podman -ErrorAction SilentlyContinue) { $engine = 'podman' }
  else { $engine = 'none' }
}
$script:engine = $engine
$containers = @()
$images = @()
$volumes = @()
$networks = @()
$errors = New-Object System.Collections.Generic.List[string]
function Write-ShellOrchestraContainersPayload([string]$payload) {
  $effectiveEncoding = $shellOrchestraOutputEncoding
  if ($effectiveEncoding -eq 'auto') {
    $effectiveEncoding = 'gzip'
  }
  $stdout = [Console]::OpenStandardOutput()
  if ($effectiveEncoding -eq 'gzip') {
    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $memory = New-Object System.IO.MemoryStream
    $gzip = New-Object System.IO.Compression.GzipStream -ArgumentList $memory, ([System.IO.Compression.CompressionMode]::Compress), $true
    try {
      $gzip.Write($bytes, 0, $bytes.Length)
    } finally {
      $gzip.Dispose()
    }
    $compressed = $memory.ToArray()
    $memory.Dispose()
    $stdout.Write($compressed, 0, $compressed.Length)
    $stdout.Flush()
    return
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}
function Write-JsonPayload($value) {
  Write-ShellOrchestraContainersPayload ((($value | ConvertTo-Json -Compress -Depth 8) + "`n"))
}
function Write-JsonEvents($events) {
  $builder = New-Object System.Text.StringBuilder
  foreach ($event in $events) {
    [void]$builder.Append(($event | ConvertTo-Json -Compress -Depth 8))
    [void]$builder.Append("`n")
  }
  Write-ShellOrchestraContainersPayload $builder.ToString()
}
function Add-ShellOrchestraContainerError([string]$Message) {
  if ($Message) {
    $clean = ($Message -replace "[`r`n`t]+", ' ').Trim()
    if ($clean) { $script:errors.Add($clean.Substring(0, [Math]::Min(240, $clean.Length))) | Out-Null }
  }
}
function Invoke-ShellOrchestraContainerLines([string[]]$Arguments, [string]$Label) {
  $output = @(& $script:engine @Arguments 2>&1)
  if ($LASTEXITCODE -ne 0) {
    Add-ShellOrchestraContainerError "$Label failed: $(($output | Select-Object -First 1 | Out-String).Trim())"
    return @()
  }
  return @($output | ForEach-Object { [string]$_ })
}
function Test-ShellOrchestraQuery([string[]]$Values) {
  if (-not $query) { return $true }
  $haystack = ($Values -join ' ').ToLowerInvariant()
  return $haystack.Contains($query.ToLowerInvariant())
}
function Get-ShellOrchestraPart([string[]]$Parts, [int]$Index) {
  if ($Parts.Count -gt $Index) { return [string]$Parts[$Index] }
  return ''
}
function Get-ShellOrchestraContainersStateToken {
  $state = [ordered]@{
    engine = $script:engine
    errors = @($script:errors)
    containers = @($containers)
    images = @($images)
    volumes = @($volumes)
    networks = @($networks)
  } | ConvertTo-Json -Compress -Depth 6
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($state)
  $hash = [System.Security.Cryptography.SHA256]::Create()
  try {
    $digest = $hash.ComputeHash($bytes)
  } finally {
    $hash.Dispose()
  }
  $hex = -join ($digest | ForEach-Object { $_.ToString('x2') })
  return 'v1-containers-' + $hex.Substring(0, 32)
}
if ($engine -ne 'none') {
  $containerLines = Invoke-ShellOrchestraContainerLines -Arguments @('ps','-a','--format','{{.ID}}	{{.Image}}	{{.Names}}	{{.State}}	{{.Status}}	{{.Ports}}	{{.CreatedAt}}	{{.RunningFor}}	{{.Size}}	{{.Command}}	{{.Labels}}	{{.Mounts}}	{{.Networks}}	{{.RestartPolicy}}') -Label "$engine ps"
  if ($containerLines.Count -eq 0 -and $errors.Count -gt 0) {
    $script:errors.Clear()
    $containerLines = Invoke-ShellOrchestraContainerLines -Arguments @('ps','-a','--format','{{.ID}}	{{.Image}}	{{.Names}}	{{.State}}	{{.Status}}	{{.Ports}}	{{.CreatedAt}}	{{.RunningFor}}	{{.Size}}	{{.Command}}	{{.Labels}}	{{.Mounts}}	{{.Networks}}	') -Label "$engine ps"
  }
  if ($containerLines.Count -eq 0 -and $errors.Count -gt 0) {
    $script:errors.Clear()
    $containerLines = Invoke-ShellOrchestraContainerLines -Arguments @('ps','-a','--format','{{.ID}}	{{.Image}}	{{.Names}}	{{.State}}	{{.Status}}	{{.Ports}}') -Label "$engine ps"
  }
  $containers = @($containerLines | ForEach-Object {
    $parts = ([string]$_).Split("`t")
    $id = Get-ShellOrchestraPart $parts 0
    $image = Get-ShellOrchestraPart $parts 1
    $name = Get-ShellOrchestraPart $parts 2
    $state = Get-ShellOrchestraPart $parts 3
    $status = Get-ShellOrchestraPart $parts 4
    $ports = Get-ShellOrchestraPart $parts 5
    $createdAt = Get-ShellOrchestraPart $parts 6
    $runningFor = Get-ShellOrchestraPart $parts 7
    $size = Get-ShellOrchestraPart $parts 8
    $command = Get-ShellOrchestraPart $parts 9
    $labels = Get-ShellOrchestraPart $parts 10
    $mounts = Get-ShellOrchestraPart $parts 11
    $networks = Get-ShellOrchestraPart $parts 12
    $restartPolicy = Get-ShellOrchestraPart $parts 13
    if (Test-ShellOrchestraQuery -Values @($id, $image, $name, $state, $status, $ports, $command, $labels, $mounts, $networks)) {
      [ordered]@{ id=$id; image=$image; name=$name; state=$state; status=$status; ports=$ports; created_at=$createdAt; running_for=$runningFor; size=$size; command=$command; labels=$labels; mounts=$mounts; networks=$networks; restart_policy=$restartPolicy }
    }
  } | Select-Object -First $limit)
  $images = @(Invoke-ShellOrchestraContainerLines -Arguments @('images','--format','{{.Repository}}	{{.Tag}}	{{.ID}}	{{.Size}}') -Label "$engine images" | ForEach-Object { $p=([string]$_).Split("`t"); if (Test-ShellOrchestraQuery -Values @($p[0],$p[1],$p[2],$p[3])) { [ordered]@{ repository=$p[0]; tag=$p[1]; id=$p[2]; size=$p[3] } } } | Select-Object -First $limit)
  $volumes = @(Invoke-ShellOrchestraContainerLines -Arguments @('volume','ls','--format','{{.Driver}}	{{.Name}}	{{.Mountpoint}}') -Label "$engine volume ls" | ForEach-Object { $p=([string]$_).Split("`t"); $mount=if ($p.Count -gt 2) { $p[2] } else { '' }; if (Test-ShellOrchestraQuery -Values @($p[0],$p[1],$mount)) { [ordered]@{ driver=$p[0]; name=$p[1]; mountpoint=$mount } } } | Select-Object -First $limit)
  $networks = @(Invoke-ShellOrchestraContainerLines -Arguments @('network','ls','--format','{{.ID}}	{{.Name}}	{{.Driver}}	{{.Scope}}') -Label "$engine network ls" | ForEach-Object { $p=([string]$_).Split("`t"); if (Test-ShellOrchestraQuery -Values @($p[0],$p[1],$p[2],$p[3])) { [ordered]@{ id=$p[0]; name=$p[1]; driver=$p[2]; scope=$p[3] } } } | Select-Object -First $limit)
}
$stateToken = Get-ShellOrchestraContainersStateToken
$notModified = $false
if (-not $query -and $knownStateToken -and $knownStateToken -eq $stateToken) {
  $notModified = $true
  $containers = @()
  $images = @()
  $volumes = @()
  $networks = @()
  $errors = New-Object System.Collections.Generic.List[string]
}
$metadata = [ordered]@{ generated_at=(Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); engine=$engine; engine_error=if ($errors.Count -gt 0) { $errors[0] } else { '' }; errors=@($errors); query=$query; state_token=$stateToken; not_modified=$notModified }
if ($streamFormat -eq 'row_events') {
  $events = New-Object 'System.Collections.Generic.List[object]'
  [void]$events.Add([ordered]@{ event = 'meta'; data = $metadata })
  if (-not $notModified) {
    foreach ($item in @($containers)) { [void]$events.Add([ordered]@{ event = 'row'; data = [ordered]@{ kind = 'container'; item = $item } }) }
    foreach ($item in @($images)) { [void]$events.Add([ordered]@{ event = 'row'; data = [ordered]@{ kind = 'image'; item = $item } }) }
    foreach ($item in @($volumes)) { [void]$events.Add([ordered]@{ event = 'row'; data = [ordered]@{ kind = 'volume'; item = $item } }) }
    foreach ($item in @($networks)) { [void]$events.Add([ordered]@{ event = 'row'; data = [ordered]@{ kind = 'network'; item = $item } }) }
  }
  [void]$events.Add([ordered]@{ event = 'done'; data = $metadata })
  Write-JsonEvents $events
  return
}
$payload = [ordered]@{ generated_at=$metadata.generated_at; engine=$engine; engine_error=$metadata.engine_error; errors=@($errors); query=$query; state_token=$stateToken; not_modified=$notModified; containers=@($containers); images=@($images); volumes=@($volumes); networks=@($networks) }
Write-JsonPayload $payload
