#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu

if ! command -v mc >/dev/null 2>&1; then
  echo "Midnight Commander is not installed on this server." >&2
  echo "Install it from the ShellOrchestra desktop app list, then try again." >&2
  exit 127
fi

# Runtime launch intentionally respects the user's Midnight Commander settings.
# Midnight Commander's subshell behaves poorly with some minimal /bin/sh
# implementations. Prefer a richer interactive shell when the target provides
# one, but do not install or silently emulate anything here.
if [ "${SHELL:-}" = "" ] || [ "$(basename "${SHELL:-/bin/sh}")" = "sh" ]; then
  if command -v bash >/dev/null 2>&1; then
    SHELL="$(command -v bash)"
    export SHELL
  elif command -v zsh >/dev/null 2>&1; then
    SHELL="$(command -v zsh)"
    export SHELL
  fi
fi

# Keep terminal-profile apps visually isolated from the login banner and launch
# wrapper prompt before the fullscreen TUI takes over.
printf '\033[2J\033[3J\033[H'
exec mc
