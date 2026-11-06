#!/bin/bash
# Source from a Mac launcher. No prompts, downloads or system configuration.
# Keep compatible with the Bash 3.2 shipped with macOS.

pasofi_select_python() {
  local pasofi_candidate pasofi_path_python
  local pasofi_platform
  pasofi_path_python="$(command -v python3 2>/dev/null || :)"
  pasofi_platform="$(uname -s 2>/dev/null || :)"
  PASOFI_PYTHON=''
  for pasofi_candidate in \
      "$pasofi_path_python" \
      /opt/homebrew/bin/python3 \
      /usr/local/bin/python3 \
      /Library/Frameworks/Python.framework/Versions/Current/bin/python3 \
      /usr/bin/python3; do
    [ -n "$pasofi_candidate" ] && [ -f "$pasofi_candidate" ] && [ -x "$pasofi_candidate" ] || continue
    # Apple may provide a python3 launcher which opens the developer-tools
    # installer. File identity also catches symlinks and hard links to the stub.
    if [ "$pasofi_platform" = Darwin ] && [ "$pasofi_candidate" -ef /usr/bin/python3 ]; then
      /usr/bin/xcode-select -p >/dev/null 2>&1 || continue
    fi
    if "$pasofi_candidate" -I -B -S -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' \
        </dev/null >/dev/null 2>&1; then
      PASOFI_PYTHON="$pasofi_candidate"
      export PASOFI_PYTHON
      return 0
    fi
  done
  printf 'PasoFi needs an installed Python 3.9 or newer. Install Python 3 from python.org, then run this launcher again. No server changes were made.\n' >&2
  return 1
}

pasofi_select_python
