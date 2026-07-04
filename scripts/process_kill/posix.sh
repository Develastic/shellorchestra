#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
pid=${SHELLORCHESTRA_PROCESS_PID:-}
signal=${SHELLORCHESTRA_PROCESS_SIGNAL:-TERM}
case "$pid" in ''|*[!0123456789]*) echo "A numeric process id is required." >&2; exit 1 ;; esac
case "$signal" in TERM|KILL|HUP|INT|QUIT|STOP|CONT|USR1|USR2) ;; '' ) signal=TERM ;; *) echo "Unsupported signal: $signal" >&2; exit 1 ;; esac
if [ "$pid" -le 1 ] 2>/dev/null; then
  echo "ShellOrchestra refuses to signal process id $pid from the UI." >&2
  exit 1
fi
kill -s "$signal" "$pid"
printf '{"ok":true,"pid":%s,"signal":"%s"}\n' "$pid" "$signal"
