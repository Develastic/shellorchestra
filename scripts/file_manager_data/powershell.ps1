# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
} catch {}
try {
  Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
} catch {}
$action = if ($env:SHELLORCHESTRA_FILE_MANAGER_ACTION) { $env:SHELLORCHESTRA_FILE_MANAGER_ACTION } else { 'locations' }
$targetPath = if ($env:SHELLORCHESTRA_FILE_MANAGER_PATH) { $env:SHELLORCHESTRA_FILE_MANAGER_PATH } else { '' }
$destinationPath = if ($env:SHELLORCHESTRA_FILE_MANAGER_DESTINATION_PATH) { $env:SHELLORCHESTRA_FILE_MANAGER_DESTINATION_PATH } else { '' }
$newName = if ($env:SHELLORCHESTRA_FILE_MANAGER_NEW_NAME) { $env:SHELLORCHESTRA_FILE_MANAGER_NEW_NAME } else { '' }
$modeValue = if ($env:SHELLORCHESTRA_FILE_MANAGER_MODE) { $env:SHELLORCHESTRA_FILE_MANAGER_MODE } else { '' }
$contentB64 = if ($env:SHELLORCHESTRA_FILE_MANAGER_CONTENT_B64) { $env:SHELLORCHESTRA_FILE_MANAGER_CONTENT_B64 } else { '' }
$overwrite = if ($env:SHELLORCHESTRA_FILE_MANAGER_OVERWRITE) { $env:SHELLORCHESTRA_FILE_MANAGER_OVERWRITE } else { 'false' }
$sourceNamesB64 = if ($env:SHELLORCHESTRA_FILE_MANAGER_SOURCE_NAMES_B64) { $env:SHELLORCHESTRA_FILE_MANAGER_SOURCE_NAMES_B64 } else { '' }
$archiveFormat = if ($env:SHELLORCHESTRA_FILE_MANAGER_ARCHIVE_FORMAT) { $env:SHELLORCHESTRA_FILE_MANAGER_ARCHIVE_FORMAT.ToLowerInvariant() } else { 'auto' }
$shellorchestraOutputEncoding = if ($env:SHELLORCHESTRA_FILE_MANAGER_OUTPUT_ENCODING) { $env:SHELLORCHESTRA_FILE_MANAGER_OUTPUT_ENCODING.ToLowerInvariant() } else { '' }
$knownListingHash = if ($env:SHELLORCHESTRA_FILE_MANAGER_KNOWN_LISTING_HASH -and $env:SHELLORCHESTRA_FILE_MANAGER_KNOWN_LISTING_HASH -match '^[A-Za-z0-9_.:-]{1,160}$') { [string]$env:SHELLORCHESTRA_FILE_MANAGER_KNOWN_LISTING_HASH } else { '' }
$streamFormat = if ($env:SHELLORCHESTRA_FILE_MANAGER_STREAM_FORMAT) { $env:SHELLORCHESTRA_FILE_MANAGER_STREAM_FORMAT.ToLowerInvariant() } else { 'json' }
$editorModeRequest = if ($env:SHELLORCHESTRA_FILE_MANAGER_EDITOR_MODE) { $env:SHELLORCHESTRA_FILE_MANAGER_EDITOR_MODE.ToLowerInvariant() } else { 'edit' }
$searchNamePattern = if ($env:SHELLORCHESTRA_FILE_MANAGER_SEARCH_NAME_PATTERN) { [string]$env:SHELLORCHESTRA_FILE_MANAGER_SEARCH_NAME_PATTERN } else { '*' }
$searchNameMode = if ($env:SHELLORCHESTRA_FILE_MANAGER_SEARCH_NAME_MODE) { $env:SHELLORCHESTRA_FILE_MANAGER_SEARCH_NAME_MODE.ToLowerInvariant() } else { 'glob' }
$searchContent = if ($env:SHELLORCHESTRA_FILE_MANAGER_SEARCH_CONTENT) { [string]$env:SHELLORCHESTRA_FILE_MANAGER_SEARCH_CONTENT } else { '' }
$searchContentMode = if ($env:SHELLORCHESTRA_FILE_MANAGER_SEARCH_CONTENT_MODE) { $env:SHELLORCHESTRA_FILE_MANAGER_SEARCH_CONTENT_MODE.ToLowerInvariant() } else { 'literal' }
$searchCaseSensitive = if ($env:SHELLORCHESTRA_FILE_MANAGER_SEARCH_CASE_SENSITIVE -eq 'true') { $true } else { $false }
$searchSkipBinary = if ($env:SHELLORCHESTRA_FILE_MANAGER_SEARCH_SKIP_BINARY -eq 'false') { $false } else { $true }
$searchStayFilesystem = if ($env:SHELLORCHESTRA_FILE_MANAGER_SEARCH_STAY_FILESYSTEM -eq 'false') { $false } else { $true }
$searchIncludeHidden = if ($env:SHELLORCHESTRA_FILE_MANAGER_SEARCH_INCLUDE_HIDDEN -eq 'false') { $false } else { $true }
[int64]$maxBytes = 262144
[int64]$offsetBytes = 0
[int64]$hashMaxBytes = 16777216
[int64]$editorMaxBytes = 33554432
[int]$editorMaxLineBytes = 65536
[int]$searchMaxResults = 1000
[int64]$searchMaxFileBytes = 1048576
[void][int64]::TryParse($env:SHELLORCHESTRA_FILE_MANAGER_MAX_BYTES, [ref]$maxBytes)
[void][int64]::TryParse($env:SHELLORCHESTRA_FILE_MANAGER_OFFSET, [ref]$offsetBytes)
[void][int64]::TryParse($env:SHELLORCHESTRA_FILE_MANAGER_HASH_MAX_BYTES, [ref]$hashMaxBytes)
[void][int64]::TryParse($env:SHELLORCHESTRA_FILE_MANAGER_EDITOR_MAX_BYTES, [ref]$editorMaxBytes)
[void][int]::TryParse($env:SHELLORCHESTRA_FILE_MANAGER_EDITOR_MAX_LINE_BYTES, [ref]$editorMaxLineBytes)
[void][int]::TryParse($env:SHELLORCHESTRA_FILE_MANAGER_SEARCH_MAX_RESULTS, [ref]$searchMaxResults)
[void][int64]::TryParse($env:SHELLORCHESTRA_FILE_MANAGER_SEARCH_MAX_FILE_BYTES, [ref]$searchMaxFileBytes)
if ($maxBytes -le 0) { $maxBytes = 262144 }
if ($offsetBytes -lt 0) { $offsetBytes = 0 }
if ($hashMaxBytes -le 0) { $hashMaxBytes = 16777216 }
if ($editorMaxBytes -le 0) { $editorMaxBytes = 33554432 }
if ($editorMaxLineBytes -le 0) { $editorMaxLineBytes = 65536 }
if ($shellorchestraOutputEncoding -and $shellorchestraOutputEncoding -notin @('auto', 'zstd', 'gzip')) { throw "Unsupported ShellOrchestra file-manager output encoding: $shellorchestraOutputEncoding" }
if ($streamFormat -notin @('json', 'row_events')) { throw "Unsupported ShellOrchestra file-manager stream format: $streamFormat" }
if ($editorModeRequest -notin @('edit', 'safe_view')) { throw "Unsupported ShellOrchestra editor mode: $editorModeRequest" }
if ($searchNameMode -notin @('glob', 'regex', 'literal')) { throw "Unsupported ShellOrchestra search name mode: $searchNameMode" }
if ($searchContentMode -notin @('regex', 'literal')) { throw "Unsupported ShellOrchestra search content mode: $searchContentMode" }
if ($searchNamePattern.Length -gt 4096 -or $searchContent.Length -gt 4096) { throw 'ShellOrchestra search pattern is too long.' }
if ($searchMaxResults -lt 1) { $searchMaxResults = 1 }
if ($searchMaxResults -gt 10000) { $searchMaxResults = 10000 }
if ($searchMaxFileBytes -lt 1024) { $searchMaxFileBytes = 1024 }
if ($searchMaxFileBytes -gt 67108864) { $searchMaxFileBytes = 67108864 }
if ([string]::IsNullOrWhiteSpace($archiveFormat)) { $archiveFormat = 'auto' }
if ($archiveFormat -notin @('auto', 'tar.zst', 'tar.gz', 'zip')) { throw "Unsupported ShellOrchestra archive format: $archiveFormat" }

function Find-ExecutableInPath($Name) {
  $extensions = @('')
  if ($env:PATHEXT) {
    foreach ($extension in ($env:PATHEXT -split ';')) {
      if (-not [string]::IsNullOrWhiteSpace($extension)) { $extensions += $extension.ToLowerInvariant() }
    }
  }
  foreach ($directory in ($env:PATH -split ';')) {
    if ([string]::IsNullOrWhiteSpace($directory)) { continue }
    foreach ($extension in $extensions) {
      $candidate = Join-Path $directory ($Name + $extension)
      try {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
      } catch {}
    }
  }
  return ''
}

function Write-Json($value) {
  $json = $value | ConvertTo-Json -Compress -Depth 12
  Write-TextPayload ($json + "`n")
}
function Write-JsonEvents($values) {
  $builder = New-Object System.Text.StringBuilder
  foreach ($value in $values) {
    [void]$builder.AppendLine(($value | ConvertTo-Json -Compress -Depth 12))
  }
  Write-TextPayload $builder.ToString()
}
function Write-TextPayload([string]$text) {
  $effectiveEncoding = $shellorchestraOutputEncoding
  $zstdPath = Find-ExecutableInPath 'zstd'
  if ($effectiveEncoding -eq 'auto') {
    if ($zstdPath) { $effectiveEncoding = 'zstd' } else { $effectiveEncoding = 'gzip' }
  }
  if ($effectiveEncoding -eq 'zstd') {
    if (-not $zstdPath) { throw 'zstd is required for zstd-compressed ShellOrchestra directory listings on this server.' }
    $tmp = [IO.Path]::GetTempFileName()
    $tmpCompressed = [IO.Path]::GetTempFileName()
    try {
      [IO.File]::WriteAllText($tmp, $text, [Text.Encoding]::UTF8)
      & $zstdPath -1 -q -f -o $tmpCompressed -- $tmp
      if ($LASTEXITCODE -ne 0) { throw "zstd failed with exit code $LASTEXITCODE" }
      $bytes = [IO.File]::ReadAllBytes($tmpCompressed)
      $stdout = [Console]::OpenStandardOutput()
      $stdout.Write($bytes, 0, $bytes.Length)
      $stdout.Flush()
    } finally {
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $tmpCompressed -Force -ErrorAction SilentlyContinue
    }
    return
  }
  if ($effectiveEncoding -eq 'gzip') {
    $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    $memory = New-Object System.IO.MemoryStream
    $gzip = New-Object System.IO.Compression.GzipStream -ArgumentList $memory, ([System.IO.Compression.CompressionMode]::Compress), $true
    try {
      $gzip.Write($bytes, 0, $bytes.Length)
    } finally {
      $gzip.Dispose()
    }
    $compressed = $memory.ToArray()
    $memory.Dispose()
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($compressed, 0, $compressed.Length)
    $stdout.Flush()
    return
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes($text)
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}
function Write-ErrorJson($message) { Write-Json ([ordered]@{ ok = $false; action = $action; error = [string]$message }) }
function New-Location($Label, $Path, $Kind) { [ordered]@{ label = [string]$Label; path = [string]$Path; kind = [string]$Kind } }
function Start-ProfileTimer() { [Diagnostics.Stopwatch]::StartNew() }
function Get-ElapsedMilliseconds($Timer) { [int64][Math]::Round($Timer.Elapsed.TotalMilliseconds) }
function Get-OtherUserHomeLocations($CurrentHomePath) {
  $locations = @()
  $currentResolved = ''
  try {
    if ($CurrentHomePath -and (Test-Path -LiteralPath $CurrentHomePath -PathType Container)) {
      $currentResolved = (Resolve-Path -LiteralPath $CurrentHomePath).Path.TrimEnd('\')
    }
  } catch {}
  $roots = @()
  $systemDrive = if ($env:SystemDrive) { $env:SystemDrive } else { 'C:' }
  $roots += (Join-Path $systemDrive 'Users')
  if ($CurrentHomePath) {
    try {
      $currentParent = Split-Path -Parent $CurrentHomePath
      if ($currentParent) { $roots += $currentParent }
    } catch {}
  }
  $seenRoots = @{}
  foreach ($root in $roots) {
    if ([string]::IsNullOrWhiteSpace($root)) { continue }
    $rootKey = $root.TrimEnd('\').ToLowerInvariant()
    if ($seenRoots.ContainsKey($rootKey)) { continue }
    $seenRoots[$rootKey] = $true
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
    try {
      foreach ($item in (Get-ChildItem -LiteralPath $root -Directory -Force -ErrorAction SilentlyContinue)) {
        $name = [string]$item.Name
        if ([string]::IsNullOrWhiteSpace($name)) { continue }
        if ($name -in @('All Users', 'Default', 'Default User', 'Public', 'WDAGUtilityAccount')) { continue }
        if ($name.StartsWith('DefaultAppPool', [StringComparison]::OrdinalIgnoreCase)) { continue }
        $path = $item.FullName.TrimEnd('\')
        if ($currentResolved -and $path.Equals($currentResolved, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $locations += New-Location "Home ($name)" $item.FullName 'user_home'
      }
    } catch {}
  }
  return $locations
}
function Resolve-UserHomePath() {
  $candidates = @()
  $knownFolder = [Environment]::GetFolderPath('UserProfile')
  if ($knownFolder) { $candidates += [ordered]@{ source = 'known-folder-user-profile'; path = $knownFolder } }
  if ($env:USERPROFILE) { $candidates += [ordered]@{ source = 'env-userprofile'; path = $env:USERPROFILE } }
  if ($env:HOMEDRIVE -and $env:HOMEPATH) { $candidates += [ordered]@{ source = 'env-home-drive-path'; path = "$env:HOMEDRIVE$env:HOMEPATH" } }
  if ($HOME) { $candidates += [ordered]@{ source = 'powershell-home'; path = $HOME } }
  if ($PWD.Path) { $candidates += [ordered]@{ source = 'current-directory'; path = $PWD.Path } }
  foreach ($candidate in $candidates) {
    $path = [string]$candidate.path
    if ([string]::IsNullOrWhiteSpace($path)) { continue }
    try {
      if (Test-Path -LiteralPath $path -PathType Container) {
        return [ordered]@{ path = (Resolve-Path -LiteralPath $path).Path; source = [string]$candidate.source }
      }
    } catch {}
  }
  return [ordered]@{ path = $PWD.Path; source = 'current-directory-fallback' }
}
function Require-ExistingPath() {
  if ([string]::IsNullOrWhiteSpace($targetPath)) { Write-ErrorJson 'Path is required.'; exit 0 }
  if (-not (Test-Path -LiteralPath $targetPath)) { Write-ErrorJson 'Path was not found.'; exit 0 }
}
function Require-SafeMutationPath($Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { Write-ErrorJson 'Path is required.'; exit 0 }
  $parent = Split-Path -Parent $Path
  if ([string]::IsNullOrWhiteSpace($parent)) { Write-ErrorJson 'Refusing to modify a filesystem root.'; exit 0 }
  $resolvedParent = Resolve-Path -LiteralPath $parent -ErrorAction SilentlyContinue
  if ($resolvedParent) {
    $root = [System.IO.Path]::GetPathRoot($resolvedParent.Path)
    if ($Path -eq $root) { Write-ErrorJson 'Refusing to modify a filesystem root.'; exit 0 }
  }
}
function Get-FileNameSafety($Name) {
  $hiddenReasons = New-Object System.Collections.Generic.List[string]
  $suspiciousReasons = New-Object System.Collections.Generic.List[string]
  if ([string]::IsNullOrEmpty($Name) -or $Name -eq '.' -or $Name -eq '..') {
    [void]$hiddenReasons.Add('reserved path component')
  }
  if ($Name.Length -gt 255) {
    [void]$hiddenReasons.Add('name is longer than 255 characters')
  }
  if ($Name.Contains('/') -or $Name.Contains('\')) {
    [void]$hiddenReasons.Add('path separator')
  }
  foreach ($char in $Name.ToCharArray()) {
    $code = [int][char]$char
    if ([char]::IsControl($char)) {
      if (-not $hiddenReasons.Contains('control character')) { [void]$hiddenReasons.Add('control character') }
      continue
    }
    if (($code -ge 0x202A -and $code -le 0x202E) -or ($code -ge 0x2066 -and $code -le 0x2069)) {
      if (-not $hiddenReasons.Contains('bidirectional text control')) { [void]$hiddenReasons.Add('bidirectional text control') }
      continue
    }
    if ($code -eq 0x200B -or $code -eq 0x200C -or $code -eq 0x200D -or $code -eq 0x2060) {
      if (-not $suspiciousReasons.Contains('contains invisible formatting characters')) { [void]$suspiciousReasons.Add('contains invisible formatting characters') }
    }
  }
  if ($Name.StartsWith('-', [StringComparison]::Ordinal)) {
    [void]$suspiciousReasons.Add('starts with a dash')
  }
  if ($Name -match '[<>`"$'';&|]') {
    [void]$suspiciousReasons.Add('contains shell or HTML-like characters')
  }
  if ($hiddenReasons.Count -gt 0) {
    return [ordered]@{ hidden = $true; safety = 'dangerous'; reasons = @($hiddenReasons) }
  }
  if ($suspiciousReasons.Count -gt 0) {
    return [ordered]@{ hidden = $false; safety = 'suspicious'; reasons = @($suspiciousReasons) }
  }
  return [ordered]@{ hidden = $false; safety = 'safe'; reasons = @() }
}
function Get-Sha256($Path) {
  try { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() } catch { '' }
}
function Get-SampleBytes($Path, [int]$Length = 8192) {
  $buffer = New-Object byte[] $Length
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    $read = $stream.Read($buffer, 0, $buffer.Length)
    if ($read -le 0) { return @() }
    if ($read -lt $buffer.Length) { return $buffer[0..($read - 1)] }
    return $buffer
  } finally { $stream.Dispose() }
}
function Get-IsTextFile($Path) {
  if ((Get-Item -LiteralPath $Path).Length -eq 0) { return $true }
  $sample = Get-SampleBytes $Path
  foreach ($byte in $sample) { if ($byte -eq 0) { return $false } }
  return $true
}
function Test-EditorTextPreflight($Path) {
  $item = Get-Item -LiteralPath $Path -Force
  $reasons = New-Object System.Collections.Generic.List[string]
  if ($item.Length -gt $editorMaxBytes) {
    return [ordered]@{ mode = 'blocked'; safe = $false; sanitized = $false; reason = 'This text file is larger than the browser editor safety limit.' }
  }
  if (-not (Get-IsTextFile $Path)) {
    return [ordered]@{ mode = 'blocked'; safe = $false; sanitized = $false; reason = 'This file looks binary in the initial text check.' }
  }
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ([Array]::IndexOf($bytes, [byte]0) -ge 0) {
    return [ordered]@{ mode = 'blocked'; safe = $false; sanitized = $false; reason = 'This file contains NUL bytes, so it is not a plain text document.' }
  }
  $text = ''
  try {
    $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
    $text = $strictUtf8.GetString($bytes)
  } catch {
    [void]$reasons.Add('This file is not valid UTF-8; ShellOrchestra opens a sanitized read-only view.')
    $text = [Text.Encoding]::UTF8.GetString($bytes)
  }
  $hasBidi = [Text.RegularExpressions.Regex]::IsMatch($text, '[\u202A-\u202E\u2066-\u2069\u200B\u200C\u200D\u2060]')
  $hasControl = [Text.RegularExpressions.Regex]::IsMatch($text, '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]')
  $longLinePattern = '[^\r\n]{' + ([int64]$editorMaxLineBytes + 1).ToString([Globalization.CultureInfo]::InvariantCulture) + '}'
  $hasLongLine = [Text.RegularExpressions.Regex]::IsMatch($text, $longLinePattern)
  if ($hasBidi) { [void]$reasons.Add('This file contains bidirectional or invisible Unicode controls; ShellOrchestra strips them in read-only view.') }
  if ($hasControl) { [void]$reasons.Add('This file contains unsafe control characters; ShellOrchestra strips them in read-only view.') }
  if ($hasLongLine) { [void]$reasons.Add('This file contains lines longer than the editor safety limit; ShellOrchestra clips those lines in read-only view.') }
  if ($reasons.Count -gt 0) {
    return [ordered]@{ mode = 'read_only'; safe = $true; sanitized = $true; reason = (($reasons | Select-Object -Unique) -join '; ') }
  }
  return [ordered]@{ mode = 'editable'; safe = $true; sanitized = $false; reason = '' }
}
function ConvertTo-EditorSafeText($Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  $builder = New-Object System.Text.StringBuilder
  $lineLength = 0
  foreach ($char in $text.ToCharArray()) {
    $code = [int][char]$char
    if (($code -ge 0x202A -and $code -le 0x202E) -or ($code -ge 0x2066 -and $code -le 0x2069) -or $code -eq 0x200B -or $code -eq 0x200C -or $code -eq 0x200D -or $code -eq 0x2060) { continue }
    if ([char]::IsControl($char) -and $char -ne "`t" -and $char -ne "`n" -and $char -ne "`r") { continue }
    if ($char -eq "`n" -or $char -eq "`r") {
      [void]$builder.Append($char)
      $lineLength = 0
      continue
    }
    $lineLength += 1
    if ($lineLength -le $editorMaxLineBytes) {
      [void]$builder.Append($char)
    } elseif ($lineLength -eq ($editorMaxLineBytes + 1)) {
      [void]$builder.Append(' [ShellOrchestra clipped an overlong line for safe read-only display]')
    }
  }
  return $builder.ToString()
}
function Read-EditorTextRangeBase64($Path, [int64]$Offset, [int64]$Length, $Preflight) {
  if ($editorModeRequest -eq 'safe_view' -or [bool]$Preflight.sanitized) {
    $safeText = ConvertTo-EditorSafeText $Path
    $safeBytes = [Text.Encoding]::UTF8.GetBytes($safeText)
    if ($Offset -ge $safeBytes.Length) { return @{ base64 = ''; length = 0; size = [int64]$safeBytes.Length } }
    $read = [int][Math]::Min($Length, [int64]($safeBytes.Length - $Offset))
    $actual = New-Object byte[] $read
    [Array]::Copy($safeBytes, [int]$Offset, $actual, 0, $read)
    return @{ base64 = [Convert]::ToBase64String($actual); length = [int64]$read; size = [int64]$safeBytes.Length }
  }
  $raw = Read-FileRangeBase64 $Path $Offset $Length
  $raw['size'] = [int64](Get-Item -LiteralPath $Path).Length
  return $raw
}
function Require-EditorReadAllowed($Path) {
  $preflight = Test-EditorTextPreflight $Path
  if ($preflight.mode -eq 'blocked') { Write-ErrorJson ([string]$preflight.reason); exit 0 }
  if ($editorModeRequest -eq 'edit' -and $preflight.mode -ne 'editable') { Write-ErrorJson ([string]$preflight.reason); exit 0 }
  return $preflight
}
function Get-MagicHex($Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  $sample = Get-SampleBytes $Path 16
  (($sample | ForEach-Object { $_.ToString('x2') }) -join '')
}
function Get-EntryType($Item) {
  if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return 'symlink' }
  if ($Item.PSIsContainer) { return 'directory' }
  return 'file'
}
function Get-PreviewKind($Path, $Type) {
  if ($Type -eq 'directory') { return 'directory' }
  if ($Type -ne 'file') { return 'other' }
  if (Test-DocumentFileName $Path) { return 'document' }
  $magic = Get-MagicHex $Path
  if ($magic.StartsWith('89504e470d0a1a0a') -or $magic.StartsWith('ffd8ff') -or $magic.StartsWith('474946383761') -or $magic.StartsWith('474946383961') -or ($magic.Length -ge 24 -and $magic.StartsWith('52494646') -and $magic.Substring(16, 8) -eq '57454250')) { return 'image' }
  if ($magic.StartsWith('25504446')) { return 'pdf' }
  if (Get-IsTextFile $Path) { return 'text' }
  return 'binary'
}
function Test-DocumentFileName($Path) {
  $lower = $Path.ToLowerInvariant()
  return $lower -match '\.(doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|rtf)$'
}
function Get-DocumentFamily($Path) {
  $lower = $Path.ToLowerInvariant()
  switch -Regex ($lower) {
    '\.docx$' { return 'word-ooxml' }
    '\.xlsx$' { return 'spreadsheet-ooxml' }
    '\.pptx$' { return 'presentation-ooxml' }
    '\.odt$' { return 'word-opendocument' }
    '\.ods$' { return 'spreadsheet-opendocument' }
    '\.odp$' { return 'presentation-opendocument' }
    '\.rtf$' { return 'rich-text' }
    '\.doc$' { return 'legacy-word' }
    '\.xls$' { return 'legacy-spreadsheet' }
    '\.ppt$' { return 'legacy-presentation' }
    default { return 'document' }
  }
}
function Get-PreviewMime($Path, $Kind) {
  $magic = Get-MagicHex $Path
  if ($Kind -eq 'text') { return 'text/plain; charset=utf-8' }
  if ($Kind -eq 'pdf') { return 'application/pdf' }
  if ($Kind -eq 'document') {
    $lower = $Path.ToLowerInvariant()
    switch -Regex ($lower) {
      '\.docx$' { return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
      '\.xlsx$' { return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
      '\.pptx$' { return 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
      '\.odt$' { return 'application/vnd.oasis.opendocument.text' }
      '\.ods$' { return 'application/vnd.oasis.opendocument.spreadsheet' }
      '\.odp$' { return 'application/vnd.oasis.opendocument.presentation' }
      '\.rtf$' { return 'application/rtf' }
      '\.doc$' { return 'application/msword' }
      '\.xls$' { return 'application/vnd.ms-excel' }
      '\.ppt$' { return 'application/vnd.ms-powerpoint' }
      default { return 'application/octet-stream' }
    }
  }
  if ($Kind -eq 'image') {
    if ($magic.StartsWith('89504e470d0a1a0a')) { return 'image/png' }
    if ($magic.StartsWith('ffd8ff')) { return 'image/jpeg' }
    if ($magic.StartsWith('474946383761') -or $magic.StartsWith('474946383961')) { return 'image/gif' }
    if ($magic.StartsWith('52494646')) { return 'image/webp' }
  }
  return 'application/octet-stream'
}
function ConvertTo-PlainXmlPreviewText([string]$Xml) {
  if ([string]::IsNullOrEmpty($Xml)) { return '' }
  $withoutTags = [regex]::Replace($Xml, '<[^>]+>', ' ')
  $decoded = [System.Net.WebUtility]::HtmlDecode($withoutTags)
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($line in ($decoded -split "(`r`n|`n|`r)")) {
    $clean = [regex]::Replace($line, '\s{2,}', ' ').Trim()
    if ($clean) { [void]$lines.Add($clean) }
  }
  return ($lines -join "`n")
}
function Get-PrintableStringsPreview($Path) {
  $limit = [int][Math]::Min([int64]$maxBytes, [int64]1048576)
  $bytes = Get-SampleBytes $Path $limit
  $builder = New-Object System.Text.StringBuilder
  $current = New-Object System.Text.StringBuilder
  foreach ($byte in $bytes) {
    if (($byte -ge 32 -and $byte -le 126) -or $byte -eq 9) {
      [void]$current.Append([char]$byte)
      continue
    }
    if ($current.Length -ge 4) {
      [void]$builder.AppendLine($current.ToString())
    }
    [void]$current.Clear()
  }
  if ($current.Length -ge 4) { [void]$builder.AppendLine($current.ToString()) }
  return $builder.ToString()
}
function Get-ZipXmlPreviewText($Path, [string[]]$Patterns) {
  try { Add-Type -AssemblyName System.IO.Compression -ErrorAction SilentlyContinue } catch {}
  try { Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue } catch {}
  $archive = $null
  try {
    $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
    $builder = New-Object System.Text.StringBuilder
    foreach ($entry in $archive.Entries) {
      $match = $false
      foreach ($pattern in $Patterns) {
        if ($entry.FullName -like $pattern) { $match = $true; break }
      }
      if (-not $match) { continue }
      if ($builder.Length -ge $maxBytes) { break }
      $stream = $entry.Open()
      try {
        $reader = New-Object System.IO.StreamReader($stream, [Text.Encoding]::UTF8, $true)
        try {
          $charsLeft = [int][Math]::Min([int64]$maxBytes, [int64]($maxBytes - $builder.Length))
          $buffer = New-Object char[] $charsLeft
          $read = $reader.Read($buffer, 0, $buffer.Length)
          if ($read -gt 0) {
            $plain = ConvertTo-PlainXmlPreviewText -Xml ([string]::new($buffer, 0, $read))
            if ($plain) {
              [void]$builder.AppendLine($plain)
              [void]$builder.AppendLine()
            }
          }
        } finally { $reader.Dispose() }
      } finally { $stream.Dispose() }
    }
    return $builder.ToString()
  } catch {
    return "Safe document text preview could not read the archive structure. Download the original only if you trust this file.`n"
  } finally {
    if ($archive) { $archive.Dispose() }
  }
}
function Get-RtfPreviewText($Path) {
  $limit = [int][Math]::Min([int64]$maxBytes, [int64]1048576)
  $bytes = Get-SampleBytes $Path $limit
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  $text = $text -replace '\\par', "`n"
  $text = $text -replace '\\tab', ' '
  $text = $text -replace '\\[A-Za-z][A-Za-z0-9-]* ?', ''
  $text = $text -replace '[{}]', ''
  return (($text -split "(`r`n|`n|`r)" | ForEach-Object { $_.Trim() } | Where-Object { $_ }) -join "`n")
}
function Get-SafeDocumentPreviewText($Path, $Kind) {
  if ($Kind -eq 'pdf') {
    $pdfBody = Get-PrintableStringsPreview $Path
    if ([string]::IsNullOrWhiteSpace($pdfBody)) { return 'No readable text was found in the bounded safe preview.' }
    return $pdfBody
  }
  $family = Get-DocumentFamily $Path
  $body = ''
  switch ($family) {
    'word-ooxml' { $body = Get-ZipXmlPreviewText $Path @('word/document.xml', 'word/header*.xml', 'word/footer*.xml', 'word/footnotes.xml', 'word/endnotes.xml') }
    'spreadsheet-ooxml' { $body = Get-ZipXmlPreviewText $Path @('xl/sharedStrings.xml', 'xl/workbook.xml', 'xl/worksheets/sheet*.xml') }
    'presentation-ooxml' { $body = Get-ZipXmlPreviewText $Path @('ppt/slides/slide*.xml', 'ppt/notesSlides/notesSlide*.xml') }
    { $_ -in @('word-opendocument', 'spreadsheet-opendocument', 'presentation-opendocument') } { $body = Get-ZipXmlPreviewText $Path @('content.xml', 'meta.xml', 'styles.xml') }
    'rich-text' { $body = Get-RtfPreviewText $Path }
    default { $body = Get-PrintableStringsPreview $Path }
  }
  if ([string]::IsNullOrWhiteSpace($body)) { $body = 'No readable text was found in the bounded safe preview.' }
  return $body
}
function Get-DetectedTextLanguage($Path) {
  $name = ([IO.Path]::GetFileName($Path)).ToLowerInvariant()
  $lowerPath = ([string]$Path).Replace('\', '/').ToLowerInvariant()
  $lowerPath = $lowerPath -replace '/private/etc/', '/etc/'
  $firstLine = ''
  try {
    $reader = [IO.StreamReader]::new($Path, [Text.Encoding]::UTF8, $true)
    try { $firstLine = [string]$reader.ReadLine() } finally { $reader.Dispose() }
  } catch {}
  $firstLine = $firstLine.TrimStart([char]0xFEFF)
  $lowerFirst = $firstLine.ToLowerInvariant()
  if ($lowerFirst.StartsWith('#!')) {
    if ($lowerFirst -match '(bash|/sh| env sh| zsh| ksh| fish|dash|ash|busybox)') { return 'shell' }
    if ($lowerFirst -match 'python') { return 'python' }
    if ($lowerFirst -match '(node|deno)') { return 'javascript' }
    if ($lowerFirst -match '(pwsh|powershell)') { return 'powershell' }
  }
  if ($lowerPath -match '/(\.?bashrc|\.?bash_profile|\.bash_login|\.bash_logout|\.bash_aliases|\.?profile|\.envrc|\.direnvrc|\.?zshrc|\.?zprofile|\.zlogin|\.zlogout|\.?zshenv|\.kshrc|\.mkshrc|\.xprofile|\.xinitrc|\.xsession|\.xsessionrc|\.bash_history|bash_history|\.zsh_history|\.sh_history|\.ash_history)$' -or $lowerPath.EndsWith('/.config/bash/bashrc') -or $lowerPath.EndsWith('/.config/bash/profile') -or $lowerPath.EndsWith('/.config/zsh/.zshrc') -or $lowerPath.EndsWith('/.config/zsh/.zprofile') -or $lowerPath.EndsWith('/.config/fish/config.fish') -or $lowerPath -match '/\.config/fish/conf\.d/.*\.fish$' -or $lowerPath.EndsWith('/.config/user-dirs.dirs') -or $lowerPath -match '/etc/(profile|bash\.bashrc|bashrc|zshrc|zprofile|zlogin|zsh/zshrc|zsh/zprofile|zsh/zshenv|zshenv|fish/config\.fish|rc\.conf|rc\.subr|rc\.common|rc\.local|bash_completion)$' -or $lowerPath -match '/etc/fish/conf\.d/.*\.fish$' -or $lowerPath -match '/etc/profile\.d/[^/]+$' -or $lowerPath -match '/etc/(default|init\.d|conf\.d|sysconfig|rc\.conf\.d|rc\.d|acpi)/[^/]+$' -or $lowerPath -match '/usr/local/etc/rc\.d/[^/]+$' -or $lowerPath -match '/etc/(portage/make\.conf|makepkg\.conf|default/grub)$' -or $lowerPath -match '/etc/(grub\.d|kernel/postinst\.d|kernel/postrm\.d|update-motd\.d)/[^/]+$' -or $lowerPath -match '/etc/periodic/[^/]+/[^/]+$' -or $lowerPath -match '/etc/local\.d/[^/]+$' -or $lowerPath -match '/etc/cron\.(hourly|daily|weekly|monthly)/[^/]+$' -or $lowerPath.Contains('/etc/bash_completion.d/') -or $lowerPath -match '/etc/(sv|service)/[^/]+/(run|finish)$' -or $lowerPath.EndsWith('/etc/x11/xsession') -or $lowerPath.EndsWith('/etc/x11/xinit/xinitrc') -or $lowerPath.EndsWith('/etc/ssh/sshrc') -or $lowerPath.EndsWith('/.ssh/rc') -or $lowerPath.EndsWith('/sshrc') -or $lowerPath.EndsWith('/rc.local')) { return 'shell' }
  if ($lowerPath.EndsWith('/etc/sudoers') -or $lowerPath.Contains('/etc/sudoers.d/') -or $lowerPath.EndsWith('/usr/local/etc/sudoers') -or $lowerPath.Contains('/usr/local/etc/sudoers.d/')) { return 'sudoers' }
  if ($lowerPath.EndsWith('/etc/crontab') -or $lowerPath.EndsWith('/etc/anacrontab') -or $lowerPath.Contains('/etc/cron.d/') -or $lowerPath.Contains('/usr/local/etc/cron.d/') -or $lowerPath.Contains('/var/spool/cron/') -or $lowerPath.Contains('/var/cron/tabs/') -or $lowerPath.Contains('/var/at/tabs/')) { return 'crontab' }
  if ($lowerPath -match '/etc/(passwd|passwd-|group|group-|shadow|shadow-|gshadow|gshadow-|subuid|subgid|master\.passwd)$') { return 'passwd' }
  if ($lowerPath.EndsWith('/.ssh/config') -or $lowerPath -match '/\.ssh/config\.d/.*\.conf$' -or $lowerPath.EndsWith('/ssh_config') -or $lowerPath.EndsWith('/sshd_config') -or $lowerPath.EndsWith('/programdata/ssh/sshd_config') -or $lowerPath.EndsWith('/programdata/ssh/ssh_config') -or $lowerPath -match '/etc/ssh/(sshd_config|ssh_config)\.d/.*\.conf$' -or $lowerPath -match '/usr/local/etc/ssh/(sshd_config|ssh_config)\.d/.*\.conf$' -or $lowerPath -match '/programdata/ssh/(sshd_config|ssh_config)\.d/.*\.conf$') { return 'sshconfig' }
  if ($lowerPath.EndsWith('/.ssh/authorized_keys') -or $lowerPath.EndsWith('/authorized_keys') -or $lowerPath.EndsWith('/authorized_keys2') -or $lowerPath.EndsWith('/.ssh/known_hosts') -or $lowerPath.EndsWith('/known_hosts') -or $lowerPath.EndsWith('/.ssh/allowed_signers') -or $lowerPath.EndsWith('/allowed_signers') -or $lowerPath.EndsWith('/etc/ssh/ssh_known_hosts') -or $lowerPath.EndsWith('/etc/ssh/ssh_known_hosts2') -or $lowerPath.EndsWith('/etc/ssh/allowed_signers') -or $lowerPath.EndsWith('/programdata/ssh/administrators_authorized_keys')) { return 'sshkeys' }
  if ($lowerPath.Contains('/etc/systemd/system/') -or $lowerPath.Contains('/etc/systemd/user/') -or $lowerPath.Contains('/lib/systemd/system/') -or $lowerPath.Contains('/lib/systemd/user/') -or $lowerPath.Contains('/usr/lib/systemd/system/') -or $lowerPath.Contains('/usr/lib/systemd/user/') -or $lowerPath.Contains('/usr/local/lib/systemd/system/') -or $lowerPath.Contains('/usr/local/lib/systemd/user/') -or $lowerPath.Contains('/run/systemd/system/') -or $lowerPath.Contains('/run/systemd/user/') -or $lowerPath.Contains('/.config/systemd/user/') -or $lowerPath -match '/etc/systemd/[^/]+\.conf$' -or $lowerPath -match '/etc/systemd/[^/]+\.conf\.d/.*\.conf$' -or $lowerPath.Contains('/etc/systemd/network/') -or $lowerPath -match '\.(network|netdev|link)$') { return 'systemd' }
  if ($lowerPath.Contains('/etc/nginx/') -or $lowerPath.EndsWith('/nginx.conf')) { return 'nginx' }
  if ($lowerPath.Contains('/etc/apache2/') -or $lowerPath.Contains('/etc/httpd/') -or $lowerPath.EndsWith('/apache2.conf') -or $lowerPath.EndsWith('/httpd.conf')) { return 'apache' }
  if ($lowerPath.EndsWith('/etc/apt/sources.list') -or $lowerPath -match '/etc/apt/sources\.list\.d/.*\.(list|sources)$') { return 'apt_sources' }
  if ($lowerPath.EndsWith('/etc/hosts') -or $lowerPath.EndsWith('/windows/system32/drivers/etc/hosts')) { return 'hosts' }
  if ($lowerPath -match '/etc/(fstab|crypttab|exports)$' -or $lowerPath.Contains('/etc/fstab.d/') -or $lowerPath.Contains('/etc/exports.d/')) { return 'fstab' }
  if ($lowerPath.EndsWith('/etc/logrotate.conf') -or $lowerPath.Contains('/etc/logrotate.d/')) { return 'logrotate' }
  if ($lowerPath.Contains('/etc/pam.d/')) { return 'pam' }
  if ($lowerPath -match '/(etc|usr/lib)/(os-release)$' -or $lowerPath -match '/etc/(lsb-release|locale\.conf|environment|vconsole\.conf)$' -or $lowerPath.Contains('/etc/environment.d/') -or $lowerPath.EndsWith('/.ssh/environment') -or $lowerPath.Contains('/.config/environment.d/')) { return 'dotenv' }
  if ($lowerPath -match '/etc/(hostname|machine-id|timezone|adjtime|locale\.gen|issue|issue\.net|motd|hosts\.allow|hosts\.deny|hosts\.equiv|resolv\.conf|nsswitch\.conf|sysctl\.conf|modules|ca-certificates\.conf|aliases|shells|services|protocols|networks|rpc|inetd\.conf|smartd\.conf|multipath\.conf|mdadm\.conf|monitrc|paths|ld\.so\.conf|ld\.so\.preload|fuse\.conf|printcap|pf\.conf|pf\.os|auto\.master|newsyslog\.conf|asl\.conf|launchd\.conf|synthetic\.conf|periodic\.conf|login\.conf|login\.access|doas\.conf|sudo\.conf|sudo_logsrvd\.conf|cron\.allow|cron\.deny|at\.allow|at\.deny|pam_env\.conf|login\.defs|adduser\.conf|deluser\.conf|rsyncd\.conf|rsyslog\.conf|chrony\.conf|ntp\.conf|nftables\.conf)$' -or $lowerPath.Contains('/etc/issue.d/') -or $lowerPath.Contains('/etc/motd.d/') -or $lowerPath.Contains('/etc/paths.d/') -or $lowerPath.Contains('/etc/resolvconf/resolv.conf.d/') -or $lowerPath.Contains('/etc/sysctl.d/') -or $lowerPath.Contains('/etc/modules-load.d/') -or $lowerPath.Contains('/etc/modprobe.d/') -or $lowerPath.Contains('/etc/depmod.d/') -or $lowerPath.Contains('/etc/binfmt.d/') -or $lowerPath.Contains('/etc/tmpfiles.d/') -or $lowerPath.Contains('/usr/lib/tmpfiles.d/') -or $lowerPath.Contains('/lib/tmpfiles.d/') -or $lowerPath.Contains('/etc/sysusers.d/') -or $lowerPath.Contains('/usr/lib/sysusers.d/') -or $lowerPath.Contains('/lib/sysusers.d/') -or $lowerPath.Contains('/etc/systemd/system-preset/') -or $lowerPath.Contains('/etc/systemd/user-preset/') -or $lowerPath.Contains('/usr/lib/systemd/system-preset/') -or $lowerPath.Contains('/usr/lib/systemd/user-preset/') -or $lowerPath.Contains('/etc/doas.d/') -or $lowerPath.Contains('/etc/ssh/authorized_principals.d/') -or $lowerPath.EndsWith('/etc/ssh/moduli') -or $lowerPath.EndsWith('/etc/ssh/revoked_keys') -or $lowerPath.EndsWith('/.ssh/authorized_principals') -or $lowerPath.EndsWith('/.pam_environment') -or $lowerPath.Contains('/etc/udev/rules.d/') -or $lowerPath.Contains('/etc/audit/rules.d/') -or $lowerPath.Contains('/etc/xinetd.d/') -or $lowerPath.Contains('/etc/network/interfaces.d/') -or $lowerPath.Contains('/etc/apt/preferences.d/') -or $lowerPath.Contains('/etc/apt/apt.conf.d/') -or $lowerPath.Contains('/etc/apt/auth.conf.d/') -or $lowerPath.Contains('/etc/dpkg/dpkg.cfg.d/') -or $lowerPath.Contains('/etc/rsyslog.d/') -or $lowerPath.Contains('/etc/ufw/applications.d/') -or $lowerPath.Contains('/etc/pf.anchors/') -or $lowerPath.Contains('/etc/auto.master.d/') -or $lowerPath.Contains('/etc/snapper/configs/') -or $lowerPath.EndsWith('/etc/apt/preferences') -or $lowerPath.EndsWith('/etc/apt/apt.conf') -or $lowerPath.EndsWith('/etc/apt/auth.conf') -or $lowerPath.EndsWith('/etc/dpkg/dpkg.cfg') -or $lowerPath.EndsWith('/etc/pacman.d/mirrorlist') -or $lowerPath.EndsWith('/etc/network/interfaces') -or $lowerPath.EndsWith('/etc/default/useradd') -or $lowerPath.EndsWith('/etc/dhcp/dhclient.conf') -or $lowerPath.EndsWith('/etc/ssh/authorized_principals') -or $lowerPath.EndsWith('/etc/audit/audit.rules') -or $lowerPath.EndsWith('/etc/mdadm/mdadm.conf') -or $lowerPath -match '/etc/security/.*\.conf$' -or $lowerPath.Contains('/etc/security/limits.d/') -or $lowerPath.Contains('/etc/security/namespace.d/') -or $lowerPath.EndsWith('/etc/selinux/config') -or $lowerPath.EndsWith('/etc/apk/repositories') -or $lowerPath.EndsWith('/etc/apk/world') -or $lowerPath -match '/etc/(debian_version|alpine-release|arch-release|gentoo-release|fedora-release|redhat-release|rocky-release|oracle-release|suse-release|SuSE-release)$' -or $lowerPath -match '/etc/ufw/.*\.rules$' -or $lowerPath -match '/etc/(iptables/rules\.v[46]|xbps\.d/.*\.conf|wpa_supplicant/.*\.conf|openvpn/.*\.conf|keepalived/.*\.conf|haproxy/.*\.cfg)$' -or $lowerPath.EndsWith('/etc/caddy/caddyfile') -or $lowerPath.EndsWith('/caddyfile') -or $lowerPath.EndsWith('/etc/redis/redis.conf') -or $lowerPath -match '/etc/redis/.*\.conf$' -or $lowerPath -match '/etc/postfix/.*\.cf$' -or $lowerPath -match '/etc/pve/.*\.(cfg|conf|fw)$' -or $lowerPath.EndsWith('/etc/nixos/configuration.nix') -or $lowerPath.EndsWith('/boot/loader/loader.conf') -or $lowerPath -match '/boot/loader/entries/.*\.conf$' -or $lowerPath -match '/windows/system32/drivers/etc/(services|protocol|networks|lmhosts)$' -or $lowerPath.EndsWith('/.config/kitty/kitty.conf') -or $lowerPath.EndsWith('/.config/nvim/init.vim') -or $lowerPath.EndsWith('/.config/tmux/tmux.conf') -or $lowerPath.EndsWith('/.config/htop/htoprc') -or $lowerPath.EndsWith('/.config/procps/toprc') -or $lowerPath.EndsWith('/.config/mc/mc.keymap') -or $lowerPath -match '/\.(inputrc|curlrc|wgetrc|netrc|tmux\.conf|screenrc|vimrc|gvimrc|exrc|nanorc|mailrc|psqlrc|pythonrc|gitignore|dockerignore|containerignore|ignore|gitattributes|npmignore|eslintignore|prettierignore)$' -or $lowerPath -match '/(requirements|constraints)\.txt$' -or $lowerPath -match '/(go\.mod|go\.work|go\.sum|cargo\.lock)$') { return 'systemconfig' }
  if ($lowerPath.EndsWith('/etc/pacman.conf') -or $lowerPath -match '/etc/pacman\.d/hooks/.*\.hook$' -or $lowerPath.EndsWith('/etc/dnf/dnf.conf') -or $lowerPath.Contains('/etc/dnf/plugins/') -or $lowerPath.EndsWith('/etc/yum.conf') -or $lowerPath.Contains('/etc/yum/pluginconf.d/') -or $lowerPath.EndsWith('/etc/zypp/zypp.conf') -or $lowerPath -match '/etc/(yum|zypp)\.repos\.d/.*\.repo$' -or $lowerPath.EndsWith('/etc/samba/smb.conf') -or $lowerPath -match '/etc/fail2ban/.*\.(conf|local)$' -or $lowerPath -match '/etc/fail2ban/.*/.*\.(conf|local)$' -or $lowerPath.Contains('/etc/supervisor/') -or $lowerPath.EndsWith('/etc/networkmanager/networkmanager.conf') -or $lowerPath -match '/etc/networkmanager/conf\.d/.*\.conf$' -or $lowerPath.Contains('/etc/networkmanager/system-connections/') -or $lowerPath -match '/etc/wireguard/.*\.conf$' -or $lowerPath -match '/etc/mysql/.*\.cnf$' -or $lowerPath.EndsWith('/etc/my.cnf') -or $lowerPath.EndsWith('/etc/ssl/openssl.cnf') -or $lowerPath.EndsWith('/etc/pip.conf') -or $lowerPath.EndsWith('/pip.conf') -or $lowerPath.EndsWith('/pip.ini') -or $lowerPath.EndsWith('/.my.cnf') -or $lowerPath.EndsWith('/.gitconfig') -or $lowerPath.EndsWith('/.git/config') -or $lowerPath.EndsWith('/.config/git/config') -or $lowerPath.EndsWith('/.gitmodules') -or $lowerPath.EndsWith('/.editorconfig') -or $lowerPath.EndsWith('/.npmrc') -or $lowerPath.EndsWith('/.yarnrc') -or $lowerPath.EndsWith('/.pnpmrc') -or $lowerPath.EndsWith('/.config/mimeapps.list') -or $lowerPath.EndsWith('/.local/share/applications/mimeapps.list') -or $lowerPath.EndsWith('/.config/mc/ini') -or $lowerPath.EndsWith('/.config/mc/panels.ini') -or $lowerPath.EndsWith('/.config/gtk-2.0/gtkrc') -or $lowerPath.EndsWith('/.config/gtk-3.0/settings.ini') -or $lowerPath.EndsWith('/.config/gtk-4.0/settings.ini') -or $lowerPath -match '/(etc/xdg/autostart|usr/share/applications|\.local/share/applications|\.config/autostart)/.*\.desktop$') { return 'ini' }
  if ($lowerPath.EndsWith('/etc/containerd/config.toml') -or $lowerPath.EndsWith('/etc/containers/containers.conf') -or $lowerPath.EndsWith('/etc/containers/storage.conf') -or $lowerPath.EndsWith('/etc/containers/registries.conf') -or $lowerPath -match '/etc/containers/registries\.conf\.d/.*\.conf$' -or $lowerPath.EndsWith('/.config/containers/containers.conf') -or $lowerPath.EndsWith('/.config/containers/storage.conf') -or $lowerPath.EndsWith('/.config/containers/registries.conf') -or $lowerPath -match '/\.config/containers/registries\.conf\.d/.*\.conf$' -or $lowerPath.EndsWith('/.config/starship.toml') -or $lowerPath.EndsWith('/.config/alacritty/alacritty.toml')) { return 'toml' }
  if ($lowerPath.EndsWith('/etc/docker/daemon.json') -or $lowerPath.EndsWith('/etc/docker/key.json') -or $lowerPath -match '/etc/docker/.*\.json$' -or $lowerPath.EndsWith('/.docker/config.json') -or $lowerPath.EndsWith('/etc/containers/policy.json') -or $lowerPath.EndsWith('/.config/containers/policy.json') -or $lowerPath -match '/(package|package-lock|tsconfig|jsconfig)\.json$') { return 'json' }
  if ($lowerPath.EndsWith('/.kube/config') -or $lowerPath -match '/etc/netplan/.*\.ya?ml$' -or $lowerPath.EndsWith('/etc/cloud/cloud.cfg') -or $lowerPath -match '/etc/cloud/cloud\.cfg\.d/.*\.(cfg|ya?ml)$') { return 'yaml' }
  if ($lowerPath -match '/(library|system/library)/(launchdaemons|launchagents|preferences)/.*\.plist$' -or $lowerPath -match '/windows/system32/inetsrv/config/.*\.config$' -or $lowerPath -match '/windows/microsoft\.net/framework(64)?[^/]*/config/.*\.config$' -or $lowerPath -match '/etc/firewalld/(zones|services)/.*\.xml$' -or $lowerPath -match '/etc/firewalld/.*\.xml$') { return 'xml' }
  switch -Regex ($name) {
    '^(dockerfile|containerfile)$' { return 'dockerfile' }
    '^(docker-compose|compose)\.ya?ml$' { return 'yaml' }
    '^(makefile|gnumakefile)$' { return 'makefile' }
    '^(caddyfile|procfile)$' { return 'systemconfig' }
    '^(bashrc|profile|zshrc|zprofile|zlogin|zlogout|zshenv|kshrc|mkshrc|xprofile|xinitrc|xsession|xsessionrc|sshrc|rc\.local)$' { return 'shell' }
    '(^|[-.])bashrc$' { return 'shell' }
    '^sudoers$' { return 'sudoers' }
    '^(crontab|anacrontab)$' { return 'crontab' }
    '^(passwd|passwd-|group|group-|shadow|shadow-|gshadow|gshadow-|subuid|subgid)$' { return 'passwd' }
    '^(ssh_config|sshd_config)$' { return 'sshconfig' }
    '^(authorized_keys|authorized_keys2|known_hosts|allowed_signers|administrators_authorized_keys)$' { return 'sshkeys' }
    '^hosts$' { return 'hosts' }
    '^(fstab|crypttab|exports)$' { return 'fstab' }
    '^logrotate\.conf$' { return 'logrotate' }
    '(^|[-_.])nginx\.conf$' { return 'nginx' }
    '^nginx\.conf$' { return 'nginx' }
    '^(apache2|httpd)\.conf$' { return 'apache' }
    '^\.env($|[.-])|\.env$' { return 'dotenv' }
    '^(\.envrc|\.direnvrc)$' { return 'shell' }
    '^crontab$' { return 'crontab' }
    '\.(service|socket|timer|mount|target|path|slice|scope|automount)$' { return 'systemd' }
    '\.(sh|bash|zsh|ksh|fish|profile)$' { return 'shell' }
    '\.(ps1|psm1|psd1)$' { return 'powershell' }
    '\.(ts|tsx)$' { return 'typescript' }
    '\.(js|jsx|mjs|cjs)$' { return 'javascript' }
    '\.(json|jsonc)$' { return 'json' }
    '\.(yaml|yml)$' { return 'yaml' }
    '\.(md|markdown)$' { return 'markdown' }
    '\.go$' { return 'go' }
    '\.py$' { return 'python' }
    '\.css$' { return 'css' }
    '\.(html|htm|jinja|j2)$' { return 'html' }
    '\.toml$' { return 'toml' }
    '\.(ini|cnf|cfg|desktop|properties|conf\.dpkg-old|conf\.dpkg-dist)$' { return 'ini' }
    '\.(xml|plist|ps1xml)$' { return 'xml' }
    '^(web|app|applicationhost|machine|nuget)\.config$' { return 'xml' }
    '\.reg$' { return 'registry' }
    '\.rules$' { return 'systemconfig' }
  }
  $sample = ''
  try { $sample = [Text.Encoding]::UTF8.GetString((Get-SampleBytes $Path 65536)).TrimStart([char]0xFEFF) } catch {}
  if ($sample -match '(?im)^\s*<\?xml' -or $sample -match '(?im)^\s*<plist(\s|>)' -or $sample -match '(?im)^\s*<configuration(\s|>)' -or $sample -match '(?im)^\s*<Project(\s|>)' -or $sample -match '(?im)^\s*<packageSources(\s|>)') { return 'xml' }
  if ($sample -match '(?im)^\s*\[(Unit|Service|Install|Socket|Timer|Mount|Path|Target|Slice|Automount)\]\s*$') { return 'systemd' }
  if ($sample -match '(?im)^\s*(Defaults|User_Alias|Runas_Alias|Host_Alias|Cmnd_Alias)(\s|$)' -or $sample -match '(?im)^\s*%?[A-Za-z0-9_.-]+\s+.*ALL\s*=') { return 'sudoers' }
  if ($sample -match '(?im)^\s*(@(reboot|hourly|daily|weekly|monthly|yearly|annually)(\s|$)|([*0-9,/:-]+\s+){5})') { return 'crontab' }
  if ($sample -match '(?im)^\s*(set\s+-[A-Za-z]*[euox][A-Za-z]*|if\s.*\sthen|for\s.*\sin\s.*\sdo|while\s.*\sdo|case\s.*\sin|[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{|function\s+[A-Za-z_][A-Za-z0-9_]*|[^#]*\$\(|[^#]*\$\{)') { return 'shell' }
  if ($sample -match '(?im)^[^:#\s\r\n][^\r\n:]*(:[^\r\n:]*){5,}\s*$') { return 'passwd' }
  if ($sample -match '(?im)^\s*(events|http|server|location|upstream|map)\s.*[\{;]') { return 'nginx' }
  if ($sample -match '(?im)^\s*(Host|Match|Include|HostName|IdentityFile|ProxyJump|ProxyCommand|StrictHostKeyChecking|PasswordAuthentication|PubkeyAuthentication)(\s|$)') { return 'sshconfig' }
  if ($sample -match '(?im)^\s*((cert-authority|command=|from=|no-[A-Za-z-]+|permit[A-Za-z-]+)[^\s]*\s+)?(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+|sk-ssh-ed25519@|sk-ecdsa-sha2-nistp[0-9]+@)\s+[A-Za-z0-9+/=]{24,}') { return 'sshkeys' }
  if ($sample -match '(?im)^\s*</?(VirtualHost|Directory|Location|IfModule|FilesMatch)' -or $sample -match '(?im)^\s*(ServerName|DocumentRoot|LoadModule|IncludeOptional|ErrorLog|CustomLog)(\s|$)') { return 'apache' }
  if ($sample -match '(?im)^\s*([0-9]{1,3}\.){3}[0-9]{1,3}\s+[A-Za-z0-9_.-]+') { return 'hosts' }
  if ($sample -match '(?im)^\s*[^#\s]+\s+[^#\s]+\s+(ext[234]|xfs|btrfs|zfs|nfs|cifs|vfat|exfat|swap|auto)\s+') { return 'fstab' }
  if ($sample -match '(?im)^\s*(daily|weekly|monthly|rotate|compress|missingok|notifempty|create|postrotate|prerotate|endscript)(\s|$)' -or $sample -match '(?im)^\s*([^#\s]*/[^#{}\s]*|[^#\s]*\*[^#{}\s]*)\s*\{') { return 'logrotate' }
  if ($sample -match '(?im)^\s*(auth|account|password|session)\s+(\[[^\]]+\]|required|requisite|sufficient|optional)') { return 'pam' }
  if ($sample -match '(?im)^\s*[\{\[]' -and $sample -match '"[A-Za-z0-9_.-]+"\s*:') { return 'json' }
  if ($sample -match '(?im)^\s*[A-Za-z0-9_.-]+:\s+([^\s#]|$)' -and $sample -match '(?im)^\s{2,}[A-Za-z0-9_.-]+:') { return 'yaml' }
  if ($sample -match '(?im)^\s*\[[^\]]+\]\s*$') { return 'ini' }
  if (([regex]::Matches($sample, '(?im)^\s*([A-Za-z0-9_.-]+)(\s*)=\s*[^#\s]') | Where-Object { $_.Groups[1].Value -match '[.-]' -or $_.Groups[2].Value.Length -gt 0 }).Count -ge 2) { return 'ini' }
  if ($sample -match '(?im)^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=') { return 'dotenv' }
  if ($sample -match '(?im)^\s*Windows Registry Editor Version') { return 'registry' }
  if (([regex]::Matches($sample, '(?im)^\s*[A-Za-z][A-Za-z0-9_.-]+:\s+[^#\s]')).Count -ge 2) { return 'systemconfig' }
  if ($sample -match '(?im)^\s*[A-Za-z][A-Za-z0-9_.-]+\s+[^#\s]+') { return 'systemconfig' }
  return 'plaintext'
}
function Read-FileRangeBase64($Path, [int64]$Offset, [int64]$Length) {
  $buffer = New-Object byte[] ([int][Math]::Min($Length, [int64]::MaxValue))
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    if ($Offset -gt 0) { [void]$stream.Seek($Offset, [IO.SeekOrigin]::Begin) }
    $read = $stream.Read($buffer, 0, $buffer.Length)
    if ($read -le 0) { return @{ base64 = ''; length = 0 } }
    $actual = New-Object byte[] $read
    [Array]::Copy($buffer, $actual, $read)
    return @{ base64 = [Convert]::ToBase64String($actual); length = [int64]$read }
  } finally { $stream.Dispose() }
}
function Get-RecursiveSize($Item) {
  if (-not $Item.PSIsContainer) { return [int64]$Item.Length }
  try {
    $sum = Get-ChildItem -LiteralPath $Item.FullName -Force -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum
    if ($null -eq $sum.Sum) { return [int64]0 }
    return [int64]$sum.Sum
  } catch {
    return [int64]0
  }
}
function Test-SearchNameMatch([string]$Name) {
  if ([string]::IsNullOrEmpty($searchNamePattern)) { return $true }
  if ($searchNameMode -eq 'literal') {
    $comparison = if ($searchCaseSensitive) { [StringComparison]::Ordinal } else { [StringComparison]::OrdinalIgnoreCase }
    return ($Name.IndexOf($searchNamePattern, $comparison) -ge 0)
  }
  if ($searchNameMode -eq 'regex') {
    $options = if ($searchCaseSensitive) { [Text.RegularExpressions.RegexOptions]::None } else { [Text.RegularExpressions.RegexOptions]::IgnoreCase }
    try { return [Text.RegularExpressions.Regex]::IsMatch($Name, $searchNamePattern, $options, [TimeSpan]::FromMilliseconds(200)) } catch { return $false }
  }
  if ($searchCaseSensitive) { return $Name -clike $searchNamePattern }
  return $Name -like $searchNamePattern
}
function Test-SearchHidden([IO.FileSystemInfo]$Item) {
  try {
    if (($Item.Attributes -band [IO.FileAttributes]::Hidden) -ne 0) { return $true }
    $parts = $Item.FullName -split '[\\/]'
    foreach ($part in $parts) {
      if ($part.StartsWith('.') -and $part.Length -gt 1) { return $true }
    }
  } catch {}
  return $false
}
function Test-SearchBinaryFile([string]$Path) {
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
      $limit = [Math]::Min(8192, [int]$stream.Length)
      if ($limit -le 0) { return $false }
      $buffer = New-Object byte[] $limit
      $read = $stream.Read($buffer, 0, $limit)
      for ($index = 0; $index -lt $read; $index += 1) {
        if ($buffer[$index] -eq 0) { return $true }
      }
      return $false
    } finally {
      $stream.Dispose()
    }
  } catch {
    return $true
  }
}
function Test-SearchContentMatch([IO.FileSystemInfo]$Item, [ref]$SkippedBinary) {
  if ([string]::IsNullOrEmpty($searchContent)) { return $true }
  if ($Item.PSIsContainer) { return $false }
  if ($searchSkipBinary -and (Test-SearchBinaryFile $Item.FullName)) {
    $SkippedBinary.Value += 1
    return $false
  }
  try {
    $stream = [IO.File]::Open($Item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
      $limit = [Math]::Min([int64]$searchMaxFileBytes, [int64]$stream.Length)
      $buffer = New-Object byte[] ([int]$limit)
      $read = if ($limit -gt 0) { $stream.Read($buffer, 0, [int]$limit) } else { 0 }
      $text = [Text.Encoding]::UTF8.GetString($buffer, 0, $read)
      if ($searchContentMode -eq 'regex') {
        $options = if ($searchCaseSensitive) { [Text.RegularExpressions.RegexOptions]::None } else { [Text.RegularExpressions.RegexOptions]::IgnoreCase }
        try { return [Text.RegularExpressions.Regex]::IsMatch($text, $searchContent, $options, [TimeSpan]::FromMilliseconds(300)) } catch { return $false }
      }
      $comparison = if ($searchCaseSensitive) { [StringComparison]::Ordinal } else { [StringComparison]::OrdinalIgnoreCase }
      return ($text.IndexOf($searchContent, $comparison) -ge 0)
    } finally {
      $stream.Dispose()
    }
  } catch {
    return $false
  }
}
function Get-SearchSnippet([IO.FileSystemInfo]$Item) {
  if ([string]::IsNullOrEmpty($searchContent) -or $Item.PSIsContainer) { return $null }
  try {
    $stream = [IO.File]::Open($Item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
      $limit = [Math]::Min([int64]$searchMaxFileBytes, [int64]$stream.Length)
      $buffer = New-Object byte[] ([int]$limit)
      $read = if ($limit -gt 0) { $stream.Read($buffer, 0, [int]$limit) } else { 0 }
      $lines = ([Text.Encoding]::UTF8.GetString($buffer, 0, $read)) -split "`r?`n"
      for ($index = 0; $index -lt $lines.Count; $index += 1) {
        $line = [string]$lines[$index]
        $matched = $false
        if ($searchContentMode -eq 'regex') {
          $options = if ($searchCaseSensitive) { [Text.RegularExpressions.RegexOptions]::None } else { [Text.RegularExpressions.RegexOptions]::IgnoreCase }
          try { $matched = [Text.RegularExpressions.Regex]::IsMatch($line, $searchContent, $options, [TimeSpan]::FromMilliseconds(50)) } catch { $matched = $false }
        } else {
          $comparison = if ($searchCaseSensitive) { [StringComparison]::Ordinal } else { [StringComparison]::OrdinalIgnoreCase }
          $matched = ($line.IndexOf($searchContent, $comparison) -ge 0)
        }
        if ($matched) { return [ordered]@{ line = [int]($index + 1); snippet = if ($line.Length -gt 240) { $line.Substring(0, 240) } else { $line } } }
      }
    } finally {
      $stream.Dispose()
    }
  } catch {}
  return $null
}

if ($action -eq 'locations') {
  $profileTimer = Start-ProfileTimer
  $homeInfo = Resolve-UserHomePath
  $homePath = [string]$homeInfo.path
  $locationsTimer = Start-ProfileTimer
  $locations = @()
  $locations += New-Location "Home ($env:USERNAME)" $homePath 'home'
  $locations += Get-OtherUserHomeLocations $homePath
  $drives = @(Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)
  foreach ($drive in $drives) { $locations += New-Location $drive.Name $drive.Root 'drive' }
  $profile = [ordered]@{
    action = 'locations'
    platform = 'windows'
    home_source = [string]$homeInfo.source
    resolved_path = $homePath
    drive_count = [int]$drives.Count
    locations_ms = Get-ElapsedMilliseconds $locationsTimer
    total_ms = Get-ElapsedMilliseconds $profileTimer
  }
  Write-Json ([ordered]@{ ok = $true; action = 'locations'; current_path = $homePath; locations = $locations; profile = $profile })
  exit 0
}

if ($action -eq 'list') {
  $profileTimer = Start-ProfileTimer
  $homeSource = ''
  $requestedPath = $targetPath
  if (-not $targetPath) {
    $homeInfo = Resolve-UserHomePath
    $targetPath = [string]$homeInfo.path
    $requestedPath = ''
    $homeSource = [string]$homeInfo.source
  }
  if (-not (Test-Path -LiteralPath $targetPath -PathType Container)) { Write-ErrorJson 'Directory was not found or is not readable.'; exit 0 }
  $resolveTimer = Start-ProfileTimer
  $resolved = (Resolve-Path -LiteralPath $targetPath).Path
  $parent = Split-Path -Parent $resolved
  if (-not $parent) { $parent = $resolved }
  $resolveMs = Get-ElapsedMilliseconds $resolveTimer
  $enumerateTimer = Start-ProfileTimer
  $items = @(Get-ChildItem -LiteralPath $resolved -Force -ErrorAction Stop)
  $enumerateMs = Get-ElapsedMilliseconds $enumerateTimer
  $sortTimer = Start-ProfileTimer
  $sortedItems = @($items | Sort-Object -Property @{Expression = { -not $_.PSIsContainer }}, Name)
  $sortMs = Get-ElapsedMilliseconds $sortTimer
  $listingHashSource = [string]::Join('|', @($sortedItems | ForEach-Object {
        $entryType = if ($_.PSIsContainer) { 'directory' } elseif ($_.PSIsContainer -eq $false) { 'file' } else { Get-EntryType $_ }
        $entrySize = if ($_.PSIsContainer) { [int64]0 } else { [int64]$_.Length }
        $entryModified = [int64](($_.LastWriteTimeUtc - [DateTime]'1970-01-01T00:00:00Z').TotalSeconds)
        "$($_.Name):${entryType}:${entrySize}:${entryModified}"
      }))
  $listingHashBytes = [Text.Encoding]::UTF8.GetBytes($listingHashSource)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $listingHash = 'sha256:' + (([BitConverter]::ToString($sha256.ComputeHash($listingHashBytes)) -replace '-', '').ToLowerInvariant())
  } finally {
    $sha256.Dispose()
  }
  if ($knownListingHash -and $knownListingHash -eq $listingHash) {
    $profile = [ordered]@{
      action = 'list'
      platform = 'windows'
      requested_path = [string]$requestedPath
      resolved_path = [string]$resolved
      home_source = [string]$homeSource
      entries_count = [int]$sortedItems.Count
      resolve_ms = [int64]$resolveMs
      enumerate_ms = [int64]$enumerateMs
      sort_ms = [int64]$sortMs
      project_ms = [int64]0
      total_ms = Get-ElapsedMilliseconds $profileTimer
      output_encoding_requested = [string]$shellorchestraOutputEncoding
      stream_format = [string]$streamFormat
    }
    if ($streamFormat -eq 'row_events') {
      Write-JsonEvents @(
        [ordered]@{ event = 'meta'; ok = $true; action = 'list'; path = $resolved; parent_path = $parent; safe_filename_mode = 'hide_dangerous'; server_sort_key = 'name'; server_sort_direction = 'asc'; server_sort_directories_first = $true; listing_hash = $listingHash; unchanged = $true; hidden_entries_count = 0; hidden_entries_reasons = @(); profile = $profile },
        [ordered]@{ event = 'done'; ok = $true; action = 'list'; path = $resolved; parent_path = $parent; listing_hash = $listingHash; unchanged = $true; entries_count = 0; hidden_entries_count = 0; hidden_entries_reasons = @(); profile = $profile }
      )
      exit 0
    }
    Write-Json ([ordered]@{ ok = $true; action = 'list'; path = $resolved; parent_path = $parent; safe_filename_mode = 'hide_dangerous'; server_sort_key = 'name'; server_sort_direction = 'asc'; server_sort_directories_first = $true; listing_hash = $listingHash; unchanged = $true; entries = @(); hidden_entries_count = 0; hidden_entries_reasons = @(); profile = $profile })
    exit 0
  }
  $projectTimer = Start-ProfileTimer
  $hiddenEntriesCount = 0
  $hiddenEntriesReasons = New-Object System.Collections.Generic.List[string]
  $entriesList = New-Object System.Collections.Generic.List[object]
  foreach ($childItem in $sortedItems) {
    $nameSafety = Get-FileNameSafety ([string]$childItem.Name)
    $reasonStrings = @($nameSafety.reasons | ForEach-Object { [string]$_ })
    if ([bool]$nameSafety.hidden) {
      $hiddenEntriesCount += 1
      foreach ($reason in $reasonStrings) {
        if (-not $hiddenEntriesReasons.Contains($reason)) { [void]$hiddenEntriesReasons.Add($reason) }
      }
      continue
    }
    [void]$entriesList.Add([ordered]@{
        name = [string]$childItem.Name
        path = [string]$childItem.FullName
        type = Get-EntryType $childItem
        is_dir = [bool]$childItem.PSIsContainer
        size = if ($childItem.PSIsContainer) { [int64]0 } else { [int64]$childItem.Length }
        mode = [string]$childItem.Mode
        user = ''
        group = ''
        modified_epoch = [int64](($childItem.LastWriteTimeUtc - [DateTime]'1970-01-01T00:00:00Z').TotalSeconds)
        name_safety = [string]$nameSafety.safety
        name_safety_reasons = $reasonStrings
      })
  }
  $entries = $entriesList.ToArray()
  $projectMs = Get-ElapsedMilliseconds $projectTimer
  $profile = [ordered]@{
    action = 'list'
    platform = 'windows'
    requested_path = [string]$requestedPath
    resolved_path = [string]$resolved
    home_source = [string]$homeSource
    entries_count = [int]$entries.Count
    resolve_ms = [int64]$resolveMs
    enumerate_ms = [int64]$enumerateMs
    sort_ms = [int64]$sortMs
    project_ms = [int64]$projectMs
    total_ms = Get-ElapsedMilliseconds $profileTimer
    output_encoding_requested = [string]$shellorchestraOutputEncoding
    stream_format = [string]$streamFormat
  }
  if ($streamFormat -eq 'row_events') {
    $events = New-Object System.Collections.Generic.List[object]
    [void]$events.Add([ordered]@{ event = 'meta'; ok = $true; action = 'list'; path = $resolved; parent_path = $parent; safe_filename_mode = 'hide_dangerous'; server_sort_key = 'name'; server_sort_direction = 'asc'; server_sort_directories_first = $true; listing_hash = $listingHash; hidden_entries_count = [int]$hiddenEntriesCount; hidden_entries_reasons = $hiddenEntriesReasons.ToArray(); profile = $profile })
    foreach ($entry in $entries) {
      [void]$events.Add([ordered]@{ event = 'row'; data = $entry })
    }
    [void]$events.Add([ordered]@{ event = 'done'; ok = $true; action = 'list'; path = $resolved; parent_path = $parent; safe_filename_mode = 'hide_dangerous'; server_sort_key = 'name'; server_sort_direction = 'asc'; server_sort_directories_first = $true; listing_hash = $listingHash; entries_count = [int]$entries.Count; hidden_entries_count = [int]$hiddenEntriesCount; hidden_entries_reasons = $hiddenEntriesReasons.ToArray(); profile = $profile })
    Write-JsonEvents $events
    exit 0
  }
  Write-Json ([ordered]@{ ok = $true; action = 'list'; path = $resolved; parent_path = $parent; safe_filename_mode = 'hide_dangerous'; server_sort_key = 'name'; server_sort_direction = 'asc'; server_sort_directories_first = $true; listing_hash = $listingHash; entries = $entries; hidden_entries_count = [int]$hiddenEntriesCount; hidden_entries_reasons = $hiddenEntriesReasons.ToArray(); profile = $profile })
  exit 0
}

if ($action -eq 'search') {
  $profileTimer = Start-ProfileTimer
  if (-not $targetPath) {
    $homeInfo = Resolve-UserHomePath
    $targetPath = [string]$homeInfo.path
  }
  if (-not (Test-Path -LiteralPath $targetPath -PathType Container)) { Write-ErrorJson 'Search root directory was not found or is not readable.'; exit 0 }
  $resolved = (Resolve-Path -LiteralPath $targetPath).Path
  $events = New-Object System.Collections.Generic.List[object]
  [void]$events.Add([ordered]@{
      event = 'meta'
      data = [ordered]@{
        ok = $true
        action = 'search'
        path = $resolved
        parent_path = $resolved
        virtual_location_kind = 'search'
        readonly = $true
        safe_filename_mode = 'hide_dangerous'
        query = [ordered]@{
          name_pattern = [string]$searchNamePattern
          name_mode = [string]$searchNameMode
          content_mode = [string]$searchContentMode
          case_sensitive = [bool]$searchCaseSensitive
          skip_binary = [bool]$searchSkipBinary
          stay_filesystem = [bool]$searchStayFilesystem
          include_hidden = [bool]$searchIncludeHidden
          max_results = [int]$searchMaxResults
          max_file_bytes = [int64]$searchMaxFileBytes
        }
      }
    })
  $results = 0
  $scanned = 0
  $skippedBinary = 0
  $unsafeNamesSkipped = 0
  $enumeration = Get-ChildItem -LiteralPath $resolved -Force -Recurse -ErrorAction SilentlyContinue
  foreach ($item in $enumeration) {
    $scanned += 1
    try {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
    } catch {}
    $nameSafety = Get-FileNameSafety ([string]$item.Name)
    if ([bool]$nameSafety.hidden) {
      $unsafeNamesSkipped += 1
      continue
    }
    if (-not $searchIncludeHidden -and (Test-SearchHidden $item)) { continue }
    if (-not (Test-SearchNameMatch ([string]$item.Name))) { continue }
    if (-not (Test-SearchContentMatch $item ([ref]$skippedBinary))) { continue }
    $snippet = Get-SearchSnippet $item
    $row = [ordered]@{
      name = [string]$item.Name
      path = [string]$item.FullName
      type = Get-EntryType $item
      is_dir = [bool]$item.PSIsContainer
      size = if ($item.PSIsContainer) { [int64]0 } else { [int64]$item.Length }
      mode = [string]$item.Mode
      user = ''
      group = ''
      modified_epoch = [int64](($item.LastWriteTimeUtc - [DateTime]'1970-01-01T00:00:00Z').TotalSeconds)
      name_safety = [string]$nameSafety.safety
      name_safety_reasons = @($nameSafety.reasons | ForEach-Object { [string]$_ })
      virtual_origin = 'search'
    }
    if ($null -ne $snippet) {
      $row.match_line = [int]$snippet.line
      $row.match_snippet = [string]$snippet.snippet
    }
    [void]$events.Add([ordered]@{ event = 'row'; data = $row })
    $results += 1
    if (($scanned % 200) -eq 0) {
      [void]$events.Add([ordered]@{ event = 'progress'; data = [ordered]@{ files_scanned = [int]$scanned; results_count = [int]$results; files_skipped_binary = [int]$skippedBinary; unsafe_names_skipped = [int]$unsafeNamesSkipped } })
    }
    if ($results -ge $searchMaxResults) { break }
  }
  $profile = [ordered]@{
    action = 'search'
    platform = 'windows'
    requested_path = [string]$targetPath
    resolved_path = [string]$resolved
    entries_count = [int]$results
    total_ms = Get-ElapsedMilliseconds $profileTimer
    output_encoding_requested = [string]$shellorchestraOutputEncoding
    stream_format = [string]$streamFormat
  }
  [void]$events.Add([ordered]@{ event = 'done'; data = [ordered]@{ ok = $true; action = 'search'; path = $resolved; parent_path = $resolved; virtual_location_kind = 'search'; readonly = $true; entries_count = [int]$results; results_count = [int]$results; files_scanned = [int]$scanned; files_skipped_binary = [int]$skippedBinary; unsafe_names_skipped = [int]$unsafeNamesSkipped; truncated = ($results -ge $searchMaxResults); profile = $profile } })
  if ($streamFormat -eq 'row_events') {
    Write-JsonEvents $events
  } else {
    $entries = @($events | Where-Object { $_.event -eq 'row' } | ForEach-Object { $_.data })
    Write-Json ([ordered]@{ ok = $true; action = 'search'; path = $resolved; parent_path = $resolved; virtual_location_kind = 'search'; readonly = $true; entries = $entries; profile = $profile })
  }
  exit 0
}

if ($action -eq 'preview') {
  Require-ExistingPath
  $item = Get-Item -LiteralPath $targetPath -Force
  $type = Get-EntryType $item
  $size = if ($item.PSIsContainer) { [int64]0 } else { [int64]$item.Length }
  $previewKind = if ($item.PSIsContainer) { 'directory' } else { Get-PreviewKind $item.FullName $type }
  $mime = if ($item.PSIsContainer) { 'inode/directory' } else { Get-PreviewMime $item.FullName $previewKind }
  $result = [ordered]@{ ok = $true; action = 'preview'; path = $item.FullName; type = $type; size = $size; sha256 = ''; info = $type; text = $false; truncated = $false; content_b64 = ''; preview_kind = $previewKind; mime = $mime; safe_preview = $false }
  if (-not $item.PSIsContainer) {
    if ($size -le $hashMaxBytes) { $result.sha256 = Get-Sha256 $item.FullName }
    if ($previewKind -eq 'text') {
      $preflight = Test-EditorTextPreflight $item.FullName
      $detectedLanguage = Get-DetectedTextLanguage $item.FullName
      $range = Read-EditorTextRangeBase64 $item.FullName 0 $maxBytes $preflight
      $result.text = $true
      $result.safe_preview = $true
      $result.truncated = ($size -gt $range.length)
      $result.encoding = 'utf-8'
      $result.detected_language = $detectedLanguage
      $result.content_b64 = $range.base64
      $result.editor_mode = [string]$preflight.mode
      $result.editor_safe = [bool]$preflight.safe
      $result.editor_sanitized = [bool]$preflight.sanitized
      $result.editor_reason = [string]$preflight.reason
    } elseif ($previewKind -eq 'image') {
      $result.safe_preview = $true
      $result.asset_b64 = ''
      $result.asset_error = ''
    } elseif ($previewKind -eq 'pdf' -or $previewKind -eq 'document') {
      $previewText = Get-SafeDocumentPreviewText $item.FullName $previewKind
      if ($previewText.Length -gt $maxBytes) {
        $previewText = $previewText.Substring(0, [int]$maxBytes)
        $result.truncated = $true
      } else {
        $result.truncated = ($size -gt ([Text.Encoding]::UTF8.GetByteCount($previewText)))
      }
      $result.text = $true
      $result.safe_preview = $true
      $result.encoding = 'utf-8'
      $result.content_b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($previewText))
      $result.asset_b64 = ''
      $result.editor_mode = 'blocked'
      $result.editor_safe = $false
      $result.editor_sanitized = $true
      $result.editor_reason = 'This file is shown through a simplified safe preview and is not opened in the code editor.'
    }
  }
  Write-Json $result
  exit 0
}

if ($action -eq 'properties' -or $action -eq 'calculate_size') {
  Require-ExistingPath
  $item = Get-Item -LiteralPath $targetPath -Force
  $type = Get-EntryType $item
  $size = if ($item.PSIsContainer) { [int64]0 } else { [int64]$item.Length }
  $recursiveSize = if ($action -eq 'calculate_size' -or $item.PSIsContainer) { Get-RecursiveSize $item } else { $size }
  $sha256 = ''
  if (-not $item.PSIsContainer -and $size -le $hashMaxBytes) { $sha256 = Get-Sha256 $item.FullName }
  Write-Json ([ordered]@{
      ok = $true
      action = $action
      path = [string]$item.FullName
      name = [string]$item.Name
      type = $type
      size = [int64]$size
      recursive_size = [int64]$recursiveSize
      mode = [string]$item.Mode
      user = ''
      group = ''
      modified_epoch = [int64](($item.LastWriteTimeUtc - [DateTime]'1970-01-01T00:00:00Z').TotalSeconds)
      sha256 = $sha256
    })
  exit 0
}

if ($action -eq 'read') {
  Require-ExistingPath
  $item = Get-Item -LiteralPath $targetPath -Force
  if ($item.PSIsContainer) { Write-ErrorJson 'Only regular files can be opened in the editor.'; exit 0 }
  $preflight = Require-EditorReadAllowed $item.FullName
  $detectedLanguage = Get-DetectedTextLanguage $item.FullName
  if ($item.Length -gt $maxBytes) { Write-ErrorJson 'This file is too large for the browser editor. ShellOrchestra can open it as a read-only chunked view instead.'; exit 0 }
  $range = Read-EditorTextRangeBase64 $item.FullName 0 $maxBytes $preflight
  if ($range.size -gt $maxBytes) { Write-ErrorJson 'The sanitized read-only view is too large for this editor request.'; exit 0 }
  Write-Json ([ordered]@{ ok = $true; action = 'read'; path = $item.FullName; type = 'file'; text = $true; encoding = 'utf-8'; detected_language = $detectedLanguage; size = [int64]$range.size; sha256 = (Get-Sha256 $item.FullName); content_b64 = $range.base64 })
  exit 0
}

if ($action -eq 'read_range') {
  Require-ExistingPath
  $item = Get-Item -LiteralPath $targetPath -Force
  if ($item.PSIsContainer) { Write-ErrorJson 'Only regular files can be opened in the editor.'; exit 0 }
  $preflight = Require-EditorReadAllowed $item.FullName
  $detectedLanguage = Get-DetectedTextLanguage $item.FullName
  $range = Read-EditorTextRangeBase64 $item.FullName $offsetBytes $maxBytes $preflight
  $nextOffset = $offsetBytes + $range.length
  Write-Json ([ordered]@{ ok = $true; action = 'read_range'; path = $item.FullName; type = 'file'; text = $true; encoding = 'utf-8'; detected_language = $detectedLanguage; size = [int64]$range.size; sha256 = ''; offset = [int64]$offsetBytes; length = [int64]$range.length; next_offset = [int64]$nextOffset; truncated = ($nextOffset -lt $range.size); content_b64 = $range.base64 })
  exit 0
}

if ($action -eq 'download') {
  Require-ExistingPath
  $item = Get-Item -LiteralPath $targetPath -Force
  if ($item.PSIsContainer) { Write-ErrorJson 'Only regular files can be downloaded.'; exit 0 }
  if ($item.Length -gt $maxBytes) { Write-ErrorJson 'This file is larger than the browser download limit. Use a terminal transfer workflow for larger files.'; exit 0 }
  $previewKind = Get-PreviewKind $item.FullName 'file'
  $mime = Get-PreviewMime $item.FullName $previewKind
  Write-Json ([ordered]@{ ok = $true; action = 'download'; path = $item.FullName; name = $item.Name; type = 'file'; encoding = 'base64'; mime = $mime; size = [int64]$item.Length; sha256 = (Get-Sha256 $item.FullName); content_b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($item.FullName)) })
  exit 0
}

if ($action -eq 'write') {
  Require-SafeMutationPath $targetPath
  $parent = Split-Path -Parent $targetPath
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { Write-ErrorJson 'Parent directory was not found.'; exit 0 }
  try { [IO.File]::WriteAllBytes($targetPath, [Convert]::FromBase64String($contentB64)) } catch { Write-ErrorJson 'The editor content could not be decoded or saved.'; exit 0 }
  $item = Get-Item -LiteralPath $targetPath -Force
  Write-Json ([ordered]@{ ok = $true; action = 'write'; path = $item.FullName; size = [int64]$item.Length; sha256 = (Get-Sha256 $item.FullName) })
  exit 0
}

if ($action -eq 'upload') {
  Require-SafeMutationPath $targetPath
  $name = Split-Path -Leaf $targetPath
  if ([string]::IsNullOrWhiteSpace($name) -or $name -eq '.' -or $name -eq '..') { Write-ErrorJson 'Remote file name is invalid.'; exit 0 }
  $parent = Split-Path -Parent $targetPath
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { Write-ErrorJson 'Parent directory was not found.'; exit 0 }
  if (Test-Path -LiteralPath $targetPath -PathType Container) { Write-ErrorJson 'A directory already exists at that path.'; exit 0 }
  if ((Test-Path -LiteralPath $targetPath) -and $overwrite -ne 'true') { Write-ErrorJson 'A file already exists at that path. Enable overwrite or choose another name.'; exit 0 }
  try { [IO.File]::WriteAllBytes($targetPath, [Convert]::FromBase64String($contentB64)) } catch { Write-ErrorJson 'The uploaded file content could not be decoded or saved.'; exit 0 }
  $item = Get-Item -LiteralPath $targetPath -Force
  Write-Json ([ordered]@{ ok = $true; action = 'upload'; path = $item.FullName; size = [int64]$item.Length; sha256 = (Get-Sha256 $item.FullName) })
  exit 0
}

if ($action -eq 'create_file') {
  Require-SafeMutationPath $targetPath
  if (Test-Path -LiteralPath $targetPath) { Write-ErrorJson 'A file or directory with this path already exists.'; exit 0 }
  New-Item -ItemType File -Path $targetPath -Force | Out-Null
  Write-Json ([ordered]@{ ok = $true; action = 'create_file'; path = (Resolve-Path -LiteralPath $targetPath).Path })
  exit 0
}

if ($action -eq 'create_directory') {
  Require-SafeMutationPath $targetPath
  New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
  Write-Json ([ordered]@{ ok = $true; action = 'create_directory'; path = (Resolve-Path -LiteralPath $targetPath).Path })
  exit 0
}

if ($action -eq 'delete') {
  Require-ExistingPath
  Require-SafeMutationPath $targetPath
  Remove-Item -LiteralPath $targetPath -Recurse -Force
  Write-Json ([ordered]@{ ok = $true; action = 'delete'; path = $targetPath })
  exit 0
}

if ($action -eq 'copy' -or $action -eq 'move') {
  Require-ExistingPath
  Require-SafeMutationPath $destinationPath
  $finalDestination = $destinationPath
  if (Test-Path -LiteralPath $destinationPath -PathType Container) { $finalDestination = Join-Path $destinationPath (Split-Path -Leaf $targetPath) }
  if ($action -eq 'move') { Move-Item -LiteralPath $targetPath -Destination $finalDestination -Force } else { Copy-Item -LiteralPath $targetPath -Destination $finalDestination -Recurse -Force }
  Write-Json ([ordered]@{ ok = $true; action = $action; path = $targetPath; destination_path = $finalDestination })
  exit 0
}

if ($action -eq 'rename') {
  Require-ExistingPath
  if ([string]::IsNullOrWhiteSpace($newName) -or $newName.Contains('/') -or $newName.Contains('\')) { Write-ErrorJson 'New name must be a simple file or folder name.'; exit 0 }
  Rename-Item -LiteralPath $targetPath -NewName $newName -Force
  Write-Json ([ordered]@{ ok = $true; action = 'rename'; path = $targetPath; destination_path = (Join-Path (Split-Path -Parent $targetPath) $newName) })
  exit 0
}

if ($action -eq 'chmod') {
  Require-ExistingPath
  Write-ErrorJson 'Permission editing is available for POSIX octal modes. Windows ACL editing is not implemented in this ShellOrchestra build.'
  exit 0
}

function Get-SelectedSourceNames() {
  if ([string]::IsNullOrWhiteSpace($sourceNamesB64)) {
    Write-ErrorJson 'Select one or more files or folders before creating an archive.'
    exit 0
  }
  try {
    $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($sourceNamesB64))
  } catch {
    Write-ErrorJson 'ShellOrchestra could not decode the selected source list.'
    exit 0
  }
  $names = @()
  foreach ($line in ($text -split "`n")) {
    $name = $line.TrimEnd("`r")
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    if ($names.Count -ge 64) { Write-ErrorJson 'Compress accepts at most 64 selected items.'; exit 0 }
    if ($name -eq '.' -or $name -eq '..' -or $name.StartsWith('-') -or $name.Contains('/') -or $name.Contains('\')) {
      Write-ErrorJson 'Selected item names must be simple safe path components.'
      exit 0
    }
    $full = Join-Path $targetPath $name
    if (-not (Test-Path -LiteralPath $full)) {
      Write-ErrorJson 'One of the selected items no longer exists on the remote server.'
      exit 0
    }
    $names += $name
  }
  if ($names.Count -eq 0) { Write-ErrorJson 'Select one or more files or folders before creating an archive.'; exit 0 }
  return $names
}

function Get-ArchiveKind($Path) {
  $lower = $Path.ToLowerInvariant()
  if ($lower.EndsWith('.zip')) { return 'zip' }
  if ($lower.EndsWith('.tar.zst') -or $lower.EndsWith('.tzst') -or $lower.EndsWith('.tar.sz')) { return 'tar.zst' }
  if ($lower.EndsWith('.tar.gz') -or $lower.EndsWith('.tgz')) { return 'tar.gz' }
  if ($lower.EndsWith('.tar.bz2') -or $lower.EndsWith('.tbz2') -or $lower.EndsWith('.tbz')) { return 'tar.bz2' }
  if ($lower.EndsWith('.tar.xz') -or $lower.EndsWith('.txz')) { return 'tar.xz' }
  if ($lower.EndsWith('.tar')) { return 'tar' }
  if ($lower.EndsWith('.rar')) { return 'rar' }
  return ''
}

function Test-SafeArchiveEntry($Entry) {
  if ([string]::IsNullOrWhiteSpace($Entry)) { return $false }
  $normalized = [string]$Entry
  if ($normalized -eq '.' -or $normalized -eq '..' -or $normalized.StartsWith('/') -or $normalized.StartsWith('\') -or $normalized.StartsWith('-')) { return $false }
  if ($normalized.Contains('../') -or $normalized.Contains('..\') -or $normalized.Contains('/..') -or $normalized.Contains('\..') -or $normalized.Contains('//') -or $normalized.Contains('\\')) { return $false }
  return $true
}

function Test-ArchiveEntries($Entries) {
  if ($Entries.Count -gt 100000) {
    Write-ErrorJson 'Archive has too many entries for safe extraction.'
    return $false
  }
  foreach ($entry in $Entries) {
    if (-not (Test-SafeArchiveEntry $entry)) {
      Write-ErrorJson 'Archive contains an unsafe entry path.'
      return $false
    }
  }
  return $true
}

function Test-ExtractionCollisions($Entries, $Destination) {
  if ($overwrite -eq 'true') { return $true }
  foreach ($entry in $Entries) {
    if ($entry.EndsWith('/') -or $entry.EndsWith('\')) { continue }
    if (Test-Path -LiteralPath (Join-Path $Destination $entry)) {
      Write-ErrorJson 'Archive extraction would overwrite an existing file. Enable overwrite or choose an empty destination folder.'
      return $false
    }
  }
  return $true
}

function Test-NoUnsafeExtractedEntries($Directory) {
  $unsafe = Get-ChildItem -LiteralPath $Directory -Force -Recurse -ErrorAction SilentlyContinue | Where-Object {
    $_.Attributes -band [IO.FileAttributes]::ReparsePoint
  } | Select-Object -First 1
  if ($unsafe) {
    Write-ErrorJson 'Archive contains symbolic links or special files. ShellOrchestra will not extract it automatically.'
    return $false
  }
  return $true
}

if ($action -eq 'compress') {
  Require-SafeMutationPath $destinationPath
  if (-not (Test-Path -LiteralPath $targetPath -PathType Container)) { Write-ErrorJson 'Compress source folder was not found.'; exit 0 }
  $destinationParent = Split-Path -Parent $destinationPath
  if (-not (Test-Path -LiteralPath $destinationParent -PathType Container)) { Write-ErrorJson 'Archive destination folder was not found.'; exit 0 }
  if ((Test-Path -LiteralPath $destinationPath) -and $overwrite -ne 'true') { Write-ErrorJson 'An archive already exists at that path. Enable overwrite or choose another name.'; exit 0 }
  $names = Get-SelectedSourceNames
  $effectiveFormat = $archiveFormat
  if ($effectiveFormat -eq 'auto') {
    if (Find-ExecutableInPath 'zstd') { $effectiveFormat = 'tar.zst' } else { $effectiveFormat = 'tar.gz' }
  }
  $tmpArchive = Join-Path ([IO.Path]::GetTempPath()) ('shellorchestra-archive-' + [Guid]::NewGuid().ToString('N') + $(if ($effectiveFormat -eq 'zip') { '.zip' } else { '.tmp' }))
  Remove-Item -LiteralPath $tmpArchive -Force -ErrorAction SilentlyContinue
  try {
    if ($effectiveFormat -eq 'zip') {
      $paths = @()
      foreach ($name in $names) { $paths += (Join-Path $targetPath $name) }
      Compress-Archive -LiteralPath $paths -DestinationPath $tmpArchive -Force
    } else {
      $tarPath = Find-ExecutableInPath 'tar'
      if (-not $tarPath) { Write-ErrorJson 'tar.exe is required to create tar archives on this server.'; exit 0 }
      $namesFile = [IO.Path]::GetTempFileName()
      [IO.File]::WriteAllLines($namesFile, $names, [Text.UTF8Encoding]::new($false))
      try {
        if ($effectiveFormat -eq 'tar.zst') {
          $zstdPath = Find-ExecutableInPath 'zstd'
          if (-not $zstdPath) { Write-ErrorJson 'zstd is required to create a .tar.zst archive.'; exit 0 }
          $tmpTar = [IO.Path]::GetTempFileName()
          try {
            & $tarPath -cf $tmpTar -C $targetPath -T $namesFile
            if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
            & $zstdPath -5 -q -f -o $tmpArchive -- $tmpTar
            if ($LASTEXITCODE -ne 0) { throw "zstd failed with exit code $LASTEXITCODE" }
          } finally {
            Remove-Item -LiteralPath $tmpTar -Force -ErrorAction SilentlyContinue
          }
        } else {
          & $tarPath -czf $tmpArchive -C $targetPath -T $namesFile
          if ($LASTEXITCODE -ne 0) { throw "tar gzip failed with exit code $LASTEXITCODE" }
          $effectiveFormat = 'tar.gz'
        }
      } finally {
        Remove-Item -LiteralPath $namesFile -Force -ErrorAction SilentlyContinue
      }
    }
    Copy-Item -LiteralPath $tmpArchive -Destination $destinationPath -Force
  } catch {
    Write-ErrorJson ('ShellOrchestra could not create the archive: ' + $_.Exception.Message)
    exit 0
  } finally {
    Remove-Item -LiteralPath $tmpArchive -Force -ErrorAction SilentlyContinue
  }
  $item = Get-Item -LiteralPath $destinationPath -Force
  Write-Json ([ordered]@{ ok = $true; action = 'compress'; path = $item.FullName; archive_format = $effectiveFormat; size = [int64]$item.Length; sha256 = (Get-Sha256 $item.FullName) })
  exit 0
}

if ($action -eq 'uncompress') {
  Require-ExistingPath
  if ([string]::IsNullOrWhiteSpace($destinationPath)) { $destinationPath = Split-Path -Parent $targetPath }
  Require-SafeMutationPath $destinationPath
  if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) { Write-ErrorJson 'Select an archive file before using Uncompress.'; exit 0 }
  if (-not (Test-Path -LiteralPath $destinationPath -PathType Container)) { New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null }
  $kind = Get-ArchiveKind $targetPath
  if (-not $kind) { Write-ErrorJson 'This archive type is not supported for extraction.'; exit 0 }
  if ($kind -eq 'rar') { Write-ErrorJson 'RAR extraction is not enabled in this build. Use archive preview or extract manually on the server.'; exit 0 }
  $extractDir = Join-Path ([IO.Path]::GetTempPath()) ('shellorchestra-extract-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
  try {
    if ($kind -eq 'zip') {
      $zip = [IO.Compression.ZipFile]::OpenRead($targetPath)
      try {
        $entries = @($zip.Entries | ForEach-Object { $_.FullName })
      } finally {
        $zip.Dispose()
      }
      if (-not (Test-ArchiveEntries $entries)) { exit 0 }
      if (-not (Test-ExtractionCollisions $entries $destinationPath)) { exit 0 }
      Expand-Archive -LiteralPath $targetPath -DestinationPath $extractDir -Force
    } else {
      $tarPath = Find-ExecutableInPath 'tar'
      if (-not $tarPath) { Write-ErrorJson 'tar.exe is required to extract this archive on Windows.'; exit 0 }
      $archiveForTar = $targetPath
      $tmpTar = ''
      if ($kind -eq 'tar.zst') {
        $zstdPath = Find-ExecutableInPath 'zstd'
        if (-not $zstdPath) { Write-ErrorJson 'zstd is required to extract .tar.zst archives on this server.'; exit 0 }
        $tmpTar = [IO.Path]::GetTempFileName()
        & $zstdPath -q -d -f -o $tmpTar -- $targetPath
        if ($LASTEXITCODE -ne 0) { throw "zstd failed with exit code $LASTEXITCODE" }
        $archiveForTar = $tmpTar
      }
      try {
        $entries = @(& $tarPath -tf $archiveForTar)
        if ($LASTEXITCODE -ne 0) { throw "tar list failed with exit code $LASTEXITCODE" }
        if (-not (Test-ArchiveEntries $entries)) { exit 0 }
        if (-not (Test-ExtractionCollisions $entries $destinationPath)) { exit 0 }
        & $tarPath -xf $archiveForTar -C $extractDir
        if ($LASTEXITCODE -ne 0) { throw "tar extract failed with exit code $LASTEXITCODE" }
      } finally {
        if ($tmpTar) { Remove-Item -LiteralPath $tmpTar -Force -ErrorAction SilentlyContinue }
      }
    }
    if (-not (Test-NoUnsafeExtractedEntries $extractDir)) { exit 0 }
    Get-ChildItem -LiteralPath $extractDir -Force | Copy-Item -Destination $destinationPath -Recurse -Force
  } catch {
    Write-ErrorJson ('ShellOrchestra could not extract this archive: ' + $_.Exception.Message)
    exit 0
  } finally {
    Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Json ([ordered]@{ ok = $true; action = 'uncompress'; path = $targetPath; destination_path = $destinationPath; archive_type = $kind })
  exit 0
}

Write-ErrorJson 'Unsupported file manager action.'
