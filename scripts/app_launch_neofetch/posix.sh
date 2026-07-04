# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

summary_tool=
if command -v neofetch >/dev/null 2>&1; then
  summary_tool=neofetch
elif command -v fastfetch >/dev/null 2>&1; then
  summary_tool=fastfetch
else
  echo "A supported system summary tool is not installed on this server." >&2
  echo "Install this app from the ShellOrchestra desktop app list, then try again." >&2
  exit 127
fi
printf '\033[2J\033[3J\033[H'
"$summary_tool"
printf '\nShellOrchestra: system summary finished. The terminal remains open below.\n\n'
runtime_shell=${SHELL:-/bin/sh}
if [ ! -x "$runtime_shell" ]; then
  runtime_shell=/bin/sh
fi
exec "$runtime_shell" -i
