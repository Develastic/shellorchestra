# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$inputStream = [Console]::OpenStandardInput()
$buffer = New-Object byte[] 65536
while ($true) {
    $read = $inputStream.Read($buffer, 0, $buffer.Length)
    if ($read -le 0) {
        break
    }
}
