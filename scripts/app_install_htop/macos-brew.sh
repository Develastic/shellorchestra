#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_ENV_HINTS=1
if command -v brew >/dev/null 2>&1; then
  brew install htop >&2
elif [ -x /opt/homebrew/bin/brew ]; then
  /opt/homebrew/bin/brew install htop >&2
elif [ -x /usr/local/bin/brew ]; then
  /usr/local/bin/brew install htop >&2
else
  echo "Homebrew was not found on this server." >&2
  exit 1
fi
printf '{"ok":true,"app":"%s","manager":"%s"}\n' "htop" "brew"
