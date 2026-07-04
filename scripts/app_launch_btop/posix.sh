# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

if ! command -v btop >/dev/null 2>&1; then
  echo "btop is not installed on this server." >&2
  echo "Install it from the ShellOrchestra desktop app list, then try again." >&2
  exit 127
fi
printf '\033[2J\033[3J\033[H'
exec btop
