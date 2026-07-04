# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$shellOrchestraOutputEncoding = if ($env:SHELLORCHESTRA_LOGS_OUTPUT_ENCODING) { $env:SHELLORCHESTRA_LOGS_OUTPUT_ENCODING.ToLowerInvariant() } else { '' }
$streamFormat = if ($env:SHELLORCHESTRA_LOGS_STREAM_FORMAT) { $env:SHELLORCHESTRA_LOGS_STREAM_FORMAT.ToLowerInvariant() } else { 'json' }
if ($shellOrchestraOutputEncoding -and $shellOrchestraOutputEncoding -notin @('auto', 'zstd', 'gzip')) { throw "Unsupported ShellOrchestra logs output encoding: $shellOrchestraOutputEncoding" }
if (-not $streamFormat) { $streamFormat = 'json' }
if ($streamFormat -notin @('json', 'row_events')) { throw "Unsupported ShellOrchestra logs stream format: $streamFormat" }

function Write-ShellOrchestraLogsOutput {
  param([Parameter(Mandatory=$true)][string]$Json)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Json)
  if ($shellOrchestraOutputEncoding -eq 'auto' -or $shellOrchestraOutputEncoding -eq 'zstd') {
    $zstd = Get-Command 'zstd.exe' -ErrorAction SilentlyContinue
    if (-not $zstd) { $zstd = Get-Command 'zstd' -ErrorAction SilentlyContinue }
    if ($zstd) {
      $tmp = [System.IO.Path]::GetTempFileName()
      $tmpCompressed = [System.IO.Path]::GetTempFileName()
      try {
        [System.IO.File]::WriteAllBytes($tmp, $bytes)
        & $zstd.Source '-3' '-q' '-f' '-o' $tmpCompressed '--' $tmp
        if ($LASTEXITCODE -ne 0) { throw "zstd failed with exit code $LASTEXITCODE" }
        $compressed = [System.IO.File]::ReadAllBytes($tmpCompressed)
        $stdout = [Console]::OpenStandardOutput()
        $stdout.Write($compressed, 0, $compressed.Length)
        $stdout.Flush()
        return
      } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $tmpCompressed -Force -ErrorAction SilentlyContinue
      }
    }
    if ($shellOrchestraOutputEncoding -eq 'zstd') { throw 'zstd is required for zstd-compressed ShellOrchestra log data on this server.' }
  }
  if ($shellOrchestraOutputEncoding -eq 'auto' -or $shellOrchestraOutputEncoding -eq 'gzip') {
    $memory = New-Object System.IO.MemoryStream
    $gzip = [System.IO.Compression.GZipStream]::new($memory, [System.IO.Compression.CompressionLevel]::Fastest, $true)
    try { $gzip.Write($bytes, 0, $bytes.Length) } finally { $gzip.Dispose() }
    $compressed = $memory.ToArray()
    $memory.Dispose()
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($compressed, 0, $compressed.Length)
    $stdout.Flush()
    return
  }
  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
}

$limit = 200
[int]::TryParse($env:SHELLORCHESTRA_LOGS_LIMIT, [ref]$limit) | Out-Null
if ($limit -lt 1) { $limit = 1 }
if ($limit -gt 5000) { $limit = 5000 }
$liveLimit = 5000
[int]::TryParse($env:SHELLORCHESTRA_LOGS_LIVE_LIMIT, [ref]$liveLimit) | Out-Null
if ($liveLimit -lt 1) { $liveLimit = 1 }
if ($liveLimit -gt 20000) { $liveLimit = 20000 }
$liveMaxBytes = 1048576
[int]::TryParse($env:SHELLORCHESTRA_LOGS_LIVE_MAX_BYTES, [ref]$liveMaxBytes) | Out-Null
if ($liveMaxBytes -lt 4096) { $liveMaxBytes = 4096 }
if ($liveMaxBytes -gt 16777216) { $liveMaxBytes = 16777216 }
$follow = $env:SHELLORCHESTRA_LOGS_FOLLOW -in @('1', 'true', 'yes')
$cursor = if ($env:SHELLORCHESTRA_LOGS_CURSOR -and $env:SHELLORCHESTRA_LOGS_CURSOR -match '^[A-Za-z0-9_.:-]+$') { [string]$env:SHELLORCHESTRA_LOGS_CURSOR } else { '' }
$nextCursor = ''
$followMode = $false
$followReset = $false
$followPartial = $false
$scannedBytes = 0
$query = if ($env:SHELLORCHESTRA_LOGS_QUERY) { [string]$env:SHELLORCHESTRA_LOGS_QUERY } else { '' }
$logPath = if ($env:SHELLORCHESTRA_LOGS_PATH) { [string]$env:SHELLORCHESTRA_LOGS_PATH } else { '' }
$logSource = if ($env:SHELLORCHESTRA_LOGS_SOURCE) { [string]$env:SHELLORCHESTRA_LOGS_SOURCE } else { '' }
$containerID = if ($env:SHELLORCHESTRA_LOGS_CONTAINER_ID) { [string]$env:SHELLORCHESTRA_LOGS_CONTAINER_ID } else { '' }
$containerEngine = if ($env:SHELLORCHESTRA_LOGS_CONTAINER_ENGINE) { [string]$env:SHELLORCHESTRA_LOGS_CONTAINER_ENGINE } else { 'auto' }
if ($logSource -and $logSource -notin @('file','system','container')) { throw "Unsupported ShellOrchestra log source: $logSource" }
$logName = if ($env:SHELLORCHESTRA_LOGS_UNIT) { [string]$env:SHELLORCHESTRA_LOGS_UNIT } else { 'System' }
$since = if ($env:SHELLORCHESTRA_LOGS_SINCE) { [string]$env:SHELLORCHESTRA_LOGS_SINCE } else { '' }
$until = if ($env:SHELLORCHESTRA_LOGS_UNTIL) { [string]$env:SHELLORCHESTRA_LOGS_UNTIL } else { '' }
if ($logName -notmatch '^[A-Za-z0-9 _./-]{1,80}$') { throw 'A safe Windows event log name is required.' }
$sinceDate = [DateTime]::MinValue
$untilDate = [DateTime]::MaxValue
$hasSince = $false
$hasUntil = $false
if ($since) {
  $hasSince = [DateTime]::TryParse($since, [ref]$sinceDate)
  if (!$hasSince) { throw 'Unsupported log since filter.' }
}
if ($until) {
  $hasUntil = [DateTime]::TryParse($until, [ref]$untilDate)
  if (!$hasUntil) { throw 'Unsupported log until filter.' }
}
$source = 'Get-WinEvent'
$format = 'windows-event'
$events = @()
if ($logSource -eq 'container') {
  if ($containerID -notmatch '^[A-Za-z0-9_.:-]{1,128}$') { throw 'A safe container id or name is required.' }
  if (-not $containerEngine -or $containerEngine -eq 'auto') {
    if (Get-Command docker -ErrorAction SilentlyContinue) { $containerEngine = 'docker' }
    elseif (Get-Command podman -ErrorAction SilentlyContinue) { $containerEngine = 'podman' }
    else { throw 'Docker or Podman is required for container logs.' }
  }
  if ($containerEngine -notin @('docker','podman')) { throw "Unsupported container engine: $containerEngine" }
  & $containerEngine inspect $containerID | Out-Null
  $nativeExitCode = if ($null -eq $global:LASTEXITCODE) { 0 } else { [int]$global:LASTEXITCODE }
  if ($nativeExitCode -ne 0) { throw "$containerEngine could not inspect the selected container." }
  $source = 'container'
  $format = 'container-stdout'
  $logName = $containerID
  $sinceCursor = ''
  if ($follow -and $cursor) {
    if ($cursor -match '^container:(?<timestamp>[0-9TtZz:.,+-]+)$') {
      $sinceCursor = [string]$Matches.timestamp
      $followMode = $true
    } else {
      $followReset = $true
    }
  }
  $engineArgs = @('logs', '--timestamps')
  if ($followMode -and $sinceCursor) {
    $engineArgs += @('--since', $sinceCursor)
  } else {
    if ($follow -and $cursor) { $followReset = $true }
    $engineArgs += @('--tail', [string]$limit)
  }
  $engineArgs += $containerID
  $output = & $containerEngine @engineArgs 2>&1
  $nativeExitCode = if ($null -eq $global:LASTEXITCODE) { 0 } else { [int]$global:LASTEXITCODE }
  $lines = @($output | ForEach-Object { [string]$_ })
  if ($nativeExitCode -ne 0) {
    $message = ($lines -join [Environment]::NewLine).Trim()
    if ($message) { throw $message }
    throw "$containerEngine logs failed with exit code $nativeExitCode"
  }
  if ($followMode -and $sinceCursor) {
    $lines = @($lines | Where-Object {
      $timestamp = ($_ -split '\s+', 2)[0]
      $timestamp -gt $sinceCursor
    })
  }
  $maxLines = if ($followMode) { $liveLimit } else { $limit }
  if ($lines.Count -gt $maxLines) {
    $followPartial = $true
    $lines = @($lines | Select-Object -First $maxLines)
  }
  if ($query) {
    $lines = @($lines | Where-Object { $_.IndexOf($query, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
  }
  $scannedBytes = [System.Text.Encoding]::UTF8.GetByteCount(($lines -join "`n"))
  $lastTimestamp = ''
  foreach ($line in $lines) {
    if ($line -match '^(?<timestamp>\d{4}-\d{2}-\d{2}[T ][^\s]+)') { $lastTimestamp = [string]$Matches.timestamp }
  }
  if ($lastTimestamp) { $nextCursor = 'container:' + $lastTimestamp }
  $events = @($lines | ForEach-Object {
    $line = [string]$_
    $timestamp = ''
    if ($line -match '^(?<ts>\d{4}-\d{2}-\d{2}[T ][^\s]+)') { $timestamp = $Matches.ts }
    if ($env:SHELLORCHESTRA_LOGS_PRIORITY -and $line.IndexOf([string]$env:SHELLORCHESTRA_LOGS_PRIORITY, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return }
    [ordered]@{ timestamp=$timestamp; host=''; unit=$containerID; priority=''; message=$line }
  })
} elseif ($logPath) {
  if ($logPath -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)[^<>|?*]{1,500}$') { throw 'A full safe Windows log file path is required.' }
  if (!(Test-Path -LiteralPath $logPath -PathType Leaf)) { throw "Log file was not found: $logPath" }
  $source = 'file'
  $format = if ($logPath -match '\.jsonl$|\.ndjson$') { 'jsonl' } elseif ($logPath -match 'access.*\.log|access_log') { 'access' } elseif ($logPath -match '\.log(?:\.\d+)?$') { 'log' } else { 'text' }
  $fileInfo = Get-Item -LiteralPath $logPath -ErrorAction Stop
  $currentLength = [int64]$fileInfo.Length
  $lines = @()
  if ($follow -and $cursor -match '^file:(?<offset>\d+)$') {
    $offset = [int64]$Matches.offset
    if ($offset -le $currentLength) {
      $followMode = $true
      $delta = $currentLength - $offset
      if ($delta -gt 0) {
        $bytesToRead = [Math]::Min([int64]$liveMaxBytes, $delta)
        if ($bytesToRead -lt $delta) { $followPartial = $true }
        $buffer = New-Object byte[] ([int]$bytesToRead)
        $stream = [System.IO.File]::Open($logPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
          [void]$stream.Seek($offset, [System.IO.SeekOrigin]::Begin)
          $read = $stream.Read($buffer, 0, $buffer.Length)
        } finally {
          $stream.Dispose()
        }
        $bytesToPublish = $read
        if ($read -gt 0) {
          $newlineCount = 0
          for ($index = 0; $index -lt $read; $index++) {
            if ($buffer[$index] -eq 10) {
              $newlineCount++
              if ($newlineCount -ge $liveLimit) {
                $bytesToPublish = $index + 1
                if ($bytesToPublish -lt $read -or $bytesToRead -lt $delta) { $followPartial = $true }
                break
              }
            }
          }
          if ($bytesToPublish -eq $read -and $bytesToRead -lt $delta -and $buffer[$read - 1] -ne 10) {
            $lastNewline = -1
            for ($index = $read - 1; $index -ge 0; $index--) {
              if ($buffer[$index] -eq 10) {
                $lastNewline = $index
                break
              }
            }
            if ($lastNewline -ge 0) {
              $bytesToPublish = $lastNewline + 1
            }
          }
        }
        if ($bytesToPublish -lt 1 -and $read -gt 0) { $bytesToPublish = $read }
        $scannedBytes = $bytesToPublish
        $text = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $bytesToPublish)
        $splitLines = @($text -split "`r?`n")
        if ($query) {
          $lines = @($splitLines | Where-Object { $_.IndexOf($query, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First $liveLimit)
        } else {
          $lines = @($splitLines | Select-Object -First $liveLimit)
        }
        $nextCursor = 'file:' + ($offset + $bytesToPublish)
      } else {
        $nextCursor = 'file:' + $offset
      }
    } else {
      $followReset = $true
    }
  }
  if (!$followMode) {
    $lines = if ($query) {
      Get-Content -LiteralPath $logPath -Tail ([Math]::Min([Math]::Max($limit * 20, $limit), 20000)) -ErrorAction Stop | Select-String -SimpleMatch -Pattern $query | Select-Object -Last $limit | ForEach-Object { [string]$_.Line }
    } else {
      Get-Content -LiteralPath $logPath -Tail $limit -ErrorAction Stop
    }
    $nextCursor = 'file:' + $currentLength
  }
  $events = @($lines | Where-Object { [string]$_ -ne '' } | ForEach-Object {
    $line = [string]$_
    $timestamp = ''
    $level = ''
    $unit = 'file'
    if ($line -match '^\{') {
      try {
        $json = $line | ConvertFrom-Json -ErrorAction Stop
        if ($json.ts) { $timestamp = [string]$json.ts }
        if ($json.level) { $level = [string]$json.level }
        if ($json.service) { $unit = [string]$json.service }
      } catch {}
    } elseif ($line -match '^(?<ts>\d{4}-\d{2}-\d{2}[T ][^ ]+)') {
      $timestamp = $Matches.ts
    }
    $lineDate = [DateTime]::MinValue
    if ($timestamp -and [DateTime]::TryParse($timestamp, [ref]$lineDate)) {
      if ($hasSince -and $lineDate -lt $sinceDate) { return }
      if ($hasUntil -and $lineDate -gt $untilDate) { return }
    }
    if ($env:SHELLORCHESTRA_LOGS_PRIORITY -and $line.IndexOf([string]$env:SHELLORCHESTRA_LOGS_PRIORITY, [StringComparison]::OrdinalIgnoreCase) -lt 0 -and $level.IndexOf([string]$env:SHELLORCHESTRA_LOGS_PRIORITY, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return }
    [ordered]@{ timestamp=$timestamp; host=$env:COMPUTERNAME; unit=$unit; priority=$level; message=$line }
  })
} else {
  $eventCursorRecordID = 0L
  if ($follow -and $cursor -match '^event:(?<record_id>\d+)$') {
    $eventCursorRecordID = [int64]$Matches.record_id
    $followMode = $true
  } elseif ($follow -and $cursor) {
    $followReset = $true
  }
  if ($followMode) {
    $eventQuery = "*[System[EventRecordID > $eventCursorRecordID]]"
    $rawEvents = @(Get-WinEvent -LogName $logName -FilterXPath $eventQuery -ErrorAction SilentlyContinue | Sort-Object RecordId | Select-Object -First ($liveLimit + 1))
    if ($rawEvents.Count -gt $liveLimit) {
      $followPartial = $true
      $rawEvents = @($rawEvents | Select-Object -First $liveLimit)
    }
  } else {
    $filter = @{ LogName = $logName }
    if ($hasSince) { $filter.StartTime = $sinceDate }
    if ($hasUntil) { $filter.EndTime = $untilDate }
    $rawEvents = @(Get-WinEvent -FilterHashtable $filter -MaxEvents $limit -ErrorAction SilentlyContinue | Sort-Object RecordId)
  }
  $maxRecordID = $eventCursorRecordID
  $events = @($rawEvents | ForEach-Object {
    if ($_.RecordId -and [int64]$_.RecordId -gt $maxRecordID) { $maxRecordID = [int64]$_.RecordId }
    $message = if ($_.Message) { [string]$_.Message } else { '' }
    $line = '{0:u} {1} {2} {3}' -f $_.TimeCreated, $_.ProviderName, $_.Id, ($message -replace "`r?`n", ' ')
    if ($query -and $line.IndexOf($query, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return }
    [ordered]@{
      timestamp = if ($_.TimeCreated) { $_.TimeCreated.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') } else { '' }
      host = $env:COMPUTERNAME
      unit = $_.ProviderName
      priority = $_.LevelDisplayName
      message = $line
    }
  })
  $nextCursor = 'event:' + $maxRecordID
}
$payload = [ordered]@{
  generated_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  platform = 'windows'
  source = $source
  path = $logPath
  format = $format
  query = $query
  unit = $logName
  priority = if ($env:SHELLORCHESTRA_LOGS_PRIORITY) { [string]$env:SHELLORCHESTRA_LOGS_PRIORITY } else { '' }
  since = $since
  until = $until
  cursor = $nextCursor
  follow = $followMode
  follow_reset = $followReset
  follow_partial = $followPartial
  scanned_bytes = $scannedBytes
  entries = @($events)
  raw_text = (($events | ForEach-Object { $_.message }) -join "`n")
}
if ($streamFormat -eq 'row_events') {
  $metadata = [ordered]@{
    generated_at = $payload.generated_at
    platform = $payload.platform
    source = $payload.source
    path = $payload.path
    format = $payload.format
    query = $payload.query
    unit = $payload.unit
    priority = $payload.priority
    since = $payload.since
    until = $payload.until
    cursor = $payload.cursor
    follow = $payload.follow
    follow_reset = $payload.follow_reset
    follow_partial = $payload.follow_partial
    scanned_bytes = $payload.scanned_bytes
  }
  $streamEvents = New-Object 'System.Collections.Generic.List[object]'
  [void]$streamEvents.Add([ordered]@{ event = 'meta'; data = $metadata })
  foreach ($event in @($events)) {
    [void]$streamEvents.Add([ordered]@{ event = 'row'; data = $event })
  }
  [void]$streamEvents.Add([ordered]@{ event = 'done'; data = $metadata })
  $builder = New-Object System.Text.StringBuilder
  foreach ($streamEvent in $streamEvents) {
    [void]$builder.Append(($streamEvent | ConvertTo-Json -Compress -Depth 8))
    [void]$builder.Append("`n")
  }
  Write-ShellOrchestraLogsOutput $builder.ToString()
} else {
  Write-ShellOrchestraLogsOutput ($payload | ConvertTo-Json -Compress -Depth 6)
}
