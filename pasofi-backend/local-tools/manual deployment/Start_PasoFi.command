#!/bin/bash
# One Finder action: guarded software deployment followed by automatic checks.
set -euo pipefail
pasofi_start_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$pasofi_start_dir/mac-python.sh"
exec "$PASOFI_PYTHON" -I -B -S "$pasofi_start_dir/pasofi-auto.py" --apply "$@"
