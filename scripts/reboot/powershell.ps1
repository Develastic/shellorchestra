# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

$ErrorActionPreference = "Stop"
if ($env:SHELLORCHESTRA_DRY_RUN -eq "1") {
    [Console]::Out.Write('{"ok":true,"action":"reboot","dry_run":true}')
    exit 0
}
Restart-Computer -Force
[Console]::Out.Write('{"ok":true,"action":"reboot"}')
