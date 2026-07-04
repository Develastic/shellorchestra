# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

bytes=${SHELLORCHESTRA_BYTES:-0}
case "$bytes" in
  ''|*[!0123456789]*)
    echo "SHELLORCHESTRA_BYTES must be a whole number of bytes" >&2
    exit 1
    ;;
esac
if [ "$bytes" -le 0 ]; then
  exit 0
fi
if [ ! -r /dev/urandom ]; then
  echo "/dev/urandom is required for ShellOrchestra Test Speed download measurements" >&2
  exit 1
fi
head -c "$bytes" /dev/urandom
