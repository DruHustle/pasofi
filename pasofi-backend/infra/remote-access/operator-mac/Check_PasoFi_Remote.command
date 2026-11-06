#!/bin/bash
# Bash 3.2 compatible. This is not the application deployment launcher.
set -u
umask 077
PASOFI_REMOTE_DIR="$(cd -- "$(dirname -- "$0")" && pwd)" || exit 2
PASOFI_REMOTE_PYTHON=''
PASOFI_REMOTE_PATH_PYTHON="$(command -v python3 2>/dev/null || :)"
for PASOFI_REMOTE_CANDIDATE in \
    "$PASOFI_REMOTE_PATH_PYTHON" \
    /opt/homebrew/bin/python3 \
    /usr/local/bin/python3 \
    /Library/Frameworks/Python.framework/Versions/Current/bin/python3 \
    /usr/bin/python3; do
  [ -n "$PASOFI_REMOTE_CANDIDATE" ] && [ -f "$PASOFI_REMOTE_CANDIDATE" ] && [ -x "$PASOFI_REMOTE_CANDIDATE" ] || continue
  # Avoid invoking Apple's developer-tools installer stub from Finder.
  if [ "$(uname -s)" = Darwin ] && [ "$PASOFI_REMOTE_CANDIDATE" -ef /usr/bin/python3 ]; then
    /usr/bin/xcode-select -p >/dev/null 2>&1 || continue
  fi
  if "$PASOFI_REMOTE_CANDIDATE" -I -B -S -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' </dev/null >/dev/null 2>&1; then
    PASOFI_REMOTE_PYTHON="$PASOFI_REMOTE_CANDIDATE"
    break
  fi
done
if [ -z "$PASOFI_REMOTE_PYTHON" ]; then
  printf 'PasoFi remote checks need installed Python 3.9 or newer. No settings were changed.\n' >&2
  exit 2
fi
exec "$PASOFI_REMOTE_PYTHON" -I -B -S "$PASOFI_REMOTE_DIR/check_remote.py" "$@"
