# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$bytesRaw = $env:SHELLORCHESTRA_BYTES
if ([string]::IsNullOrWhiteSpace($bytesRaw)) {
    [Console]::Error.WriteLine("SHELLORCHESTRA_BYTES must be provided.")
    exit 1
}
$bytes = 0L
if (-not [Int64]::TryParse($bytesRaw, [ref]$bytes) -or $bytes -lt 0) {
    [Console]::Error.WriteLine("SHELLORCHESTRA_BYTES must be a whole number of bytes.")
    exit 1
}
$outputStream = [Console]::OpenStandardOutput()
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $buffer = New-Object byte[] 65536
    $remaining = $bytes
    while ($remaining -gt 0) {
        $count = [Math]::Min([int64]$buffer.Length, $remaining)
        if ($count -ne $buffer.Length) {
            $buffer = New-Object byte[] ([int]$count)
        }
        $rng.GetBytes($buffer)
        $outputStream.Write($buffer, 0, [int]$count)
        $remaining -= $count
    }
} finally {
    $rng.Dispose()
}
