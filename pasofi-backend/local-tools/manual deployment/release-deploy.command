#!/bin/bash
# Finder/Terminal entry point; compatible with the Bash 3.2 shipped by macOS.
set -euo pipefail

pasofi_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Advanced command-line arguments retain their exact values and working directory.
if [ "$#" -gt 0 ]; then
  exec /bin/bash "$pasofi_script_dir/release-deploy.sh" "$@"
fi

for pasofi_required_file in mac-python.sh pasofi-auto.py; do
  if [ ! -f "$pasofi_script_dir/$pasofi_required_file" ]; then
    printf 'STOPPED: The automatic Mac package is incomplete. Extract the complete ZIP and keep its files together.\n' >&2
    exit 1
  fi
done

# The dispatcher discovers the configured server, verifies the existing installation,
# and performs the guarded deployment and postchecks without collecting form fields.
# shellcheck source=mac-python.sh
source "$pasofi_script_dir/mac-python.sh"
exec "$PASOFI_PYTHON" -I -B -S "$pasofi_script_dir/pasofi-auto.py" --apply
