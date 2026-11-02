#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../production"
kind=${1:-diff}
case "$kind" in full|diff|incr|check|info|stanza-create) ;; *) echo 'Expected full, diff, incr, check, info, or stanza-create' >&2; exit 2;; esac
compose=(docker compose -f compose.yaml -f ../backup-production/compose.yaml)
if [[ "$kind" == full || "$kind" == diff || "$kind" == incr ]]; then
 "${compose[@]}" exec -T --user postgres postgres pgbackrest --stanza=pamofi --type="$kind" backup
 "${compose[@]}" exec -T --user postgres postgres pgbackrest --stanza=pamofi check
elif [[ "$kind" == info ]]; then
 "${compose[@]}" exec -T --user postgres postgres pgbackrest --stanza=pamofi --output=json info
else
 "${compose[@]}" exec -T --user postgres postgres pgbackrest --stanza=pamofi "$kind"
fi
