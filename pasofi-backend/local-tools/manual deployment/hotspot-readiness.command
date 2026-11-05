#!/bin/bash
# Read-only Mac entry point; compatible with macOS Bash 3.2.
set -euo pipefail
pasofi_readiness_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [ "$#" -gt 0 ]; then
  exec python3 "$pasofi_readiness_dir/hotspot-readiness.py" "$@"
fi
pasofi_readiness_finish() {
  local pasofi_status=$?
  trap - EXIT
  if [ -t 0 ]; then
    printf '\nPress Return to finish. '
    IFS= read -r pasofi_finish_input || :
  fi
  exit "$pasofi_status"
}
trap pasofi_readiness_finish EXIT
printf 'PasoFi hotspot readiness — read-only\n\n'
printf 'Use the existing Oracle SSH alias. Do not enter passwords or private keys.\n'
command -v python3 >/dev/null 2>&1 && command -v ssh >/dev/null 2>&1 || {
  printf 'Python 3.9 or newer and the existing OpenSSH tools are required.\n' >&2
  exit 1
}
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || exit 1
printf 'Existing SSH alias: '
IFS= read -r pasofi_readiness_host
printf 'Existing Compose project (optional; press Return to discover it): '
IFS= read -r pasofi_readiness_project
pasofi_readiness_args=(--host "$pasofi_readiness_host")
if [ -n "$pasofi_readiness_project" ]; then
  pasofi_readiness_args+=(--project "$pasofi_readiness_project")
fi
cd -- "$pasofi_readiness_dir"
python3 "$pasofi_readiness_dir/hotspot-readiness.py" "${pasofi_readiness_args[@]}"
