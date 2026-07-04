#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu

command_text=${SHELLORCHESTRA_CUSTOM_COMMAND:-}
if [ -z "$command_text" ]; then
  echo "Custom shortcut command is empty." >&2
  exit 64
fi

runtime_shell=${SHELL:-/bin/sh}
if [ ! -x "$runtime_shell" ]; then
  runtime_shell=/bin/sh
fi

printf '\033[2J\033[3J\033[H'
printf 'ShellOrchestra custom shortcut\n'
printf 'Command: %s\n\n' "$command_text"
set +e
"$runtime_shell" -lc "$command_text"
status=$?
set -e
printf '\nShellOrchestra: custom shortcut finished with status %s. Opening interactive shell.\n' "$status"
exec "$runtime_shell" -i
