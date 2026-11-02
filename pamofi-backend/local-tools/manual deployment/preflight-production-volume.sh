#!/usr/bin/env bash
# Read-only check of the explicitly selected production volume. This never
# creates, initializes, migrates, deletes or repairs a database.
set -euo pipefail
volume=${PAMOFI_DATABASE_VOLUME:-}
mode=${PAMOFI_INSTALL_MODE:-}
expected_id=${PAMOFI_EXPECTED_SYSTEM_ID:-}
[[ "$volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || { echo 'Set PAMOFI_DATABASE_VOLUME to an existing named Docker volume.' >&2; exit 1; }
case "$mode" in
 new) ;;
 upgrade) [[ "$expected_id" =~ ^[0-9]{1,20}$ ]] || { echo 'For upgrades, set the previously recorded PAMOFI_EXPECTED_SYSTEM_ID.' >&2; exit 1; } ;;
 *) echo 'Set PAMOFI_INSTALL_MODE to new or upgrade.' >&2; exit 1 ;;
esac
docker volume inspect "$volume" >/dev/null
export PAMOFI_INSTALL_MODE="$mode" PAMOFI_EXPECTED_SYSTEM_ID="$expected_id"
image='postgres:17.11-alpine3.23@sha256:2ad58d61b036d41f2613302e8c0fee03f6fe51e94d68087327ac45d1cebd4b5e'
docker run --rm --network none --read-only --user 70:70 --cap-drop ALL --security-opt no-new-privileges \
 --env PAMOFI_INSTALL_MODE --env PAMOFI_EXPECTED_SYSTEM_ID \
 --mount "type=volume,source=$volume,target=/inspect,readonly" --entrypoint /bin/sh "$image" -eu -c '
  if [ -e /inspect/PG_VERSION ] || [ -L /inspect/PG_VERSION ]; then
    echo "Volume contains a root-level PostgreSQL cluster; production expects pgdata/. Stop and plan an explicit migration." >&2; exit 1
  fi
  if [ "$PAMOFI_INSTALL_MODE" = new ]; then
    entries=$(ls -A /inspect)
    if [ -n "$entries" ]; then echo "New installation requires a completely empty volume." >&2; exit 1; fi
    echo "Volume is empty and suitable for a new cluster; initialization has not been performed."
    exit 0
  fi
  if [ -L /inspect/pgdata ] || [ ! -d /inspect/pgdata ] || [ -L /inspect/pgdata/PG_VERSION ] || [ ! -f /inspect/pgdata/PG_VERSION ]; then
    echo "Expected a non-symlinked production pgdata/ cluster." >&2; exit 1
  fi
  if [ "$(cat /inspect/pgdata/PG_VERSION)" != 17 ]; then echo "PostgreSQL major version is not 17." >&2; exit 1; fi
  actual_id=$(LC_ALL=C pg_controldata /inspect/pgdata | awk -F: '\''/^Database system identifier:/ {gsub(/[[:space:]]/,"",$2); print $2}'\'')
  if [ -z "$actual_id" ] || [ "$actual_id" != "$PAMOFI_EXPECTED_SYSTEM_ID" ]; then
    echo "Database system identifier does not match the recorded production cluster." >&2; exit 1
  fi
  echo "Volume contains the recorded PostgreSQL 17 production cluster."
'
