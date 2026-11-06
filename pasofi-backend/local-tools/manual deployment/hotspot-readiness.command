#!/bin/bash
# Automatic read-only Mac entry point; compatible with macOS Bash 3.2.
set -euo pipefail
pasofi_readiness_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=mac-python.sh
. "$pasofi_readiness_dir/mac-python.sh"
command -v ssh >/dev/null 2>&1 || {
  printf 'OpenSSH is required. No connection was attempted.\n' >&2
  exit 1
}
printf 'PasoFi hotspot readiness — automatic, read-only\n\n'
cd -- "$pasofi_readiness_dir"
exec "$PASOFI_PYTHON" -I -B -S "$pasofi_readiness_dir/hotspot-readiness.py" "$@"
