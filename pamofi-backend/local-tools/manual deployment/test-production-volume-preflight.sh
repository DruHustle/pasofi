#!/usr/bin/env bash
# Disposable Docker volumes only. Never use a real deployment volume.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
run_id=$(openssl rand -hex 8)
empty="pamofi-volume-test-$run_id-empty"
existing="pamofi-volume-test-$run_id-existing"
created=()
cleanup() {
  status=$?
  set +u
  for volume in "${created[@]}"; do docker volume rm "$volume" >/dev/null 2>&1 || true; done
  exit "$status"
}
trap 'cleanup' EXIT
for volume in "$empty" "$existing"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then echo 'Unexpected existing test volume' >&2; exit 1; fi
  docker volume create --label "com.pamofi.volume-test=$run_id" "$volume" >/dev/null
  created+=("$volume")
done
image='postgres:17.11-alpine3.23@sha256:2ad58d61b036d41f2613302e8c0fee03f6fe51e94d68087327ac45d1cebd4b5e'
check() { PAMOFI_DATABASE_VOLUME="$1" PAMOFI_INSTALL_MODE="$2" PAMOFI_EXPECTED_SYSTEM_ID="${3:-}" bash "$here/preflight-production-volume.sh"; }
expect_failure() { if "$@" >/dev/null 2>&1; then echo 'Preflight unexpectedly accepted an unsafe volume' >&2; exit 1; fi; }
check "$empty" new
expect_failure check "$empty" upgrade 123
expect_failure check "$empty" invalid
# Create a real PostgreSQL cluster in the second disposable volume.
docker run --rm --network none --user root --mount "type=volume,source=$existing,target=/fixture" --entrypoint /bin/sh "$image" -eu -c \
 'mkdir -p /fixture/pgdata && chown 70:70 /fixture/pgdata'
docker run --rm --network none --user 70:70 --mount "type=volume,source=$existing,target=/fixture" --entrypoint initdb "$image" \
 -D /fixture/pgdata --username=pamofi_bootstrap --auth=trust >/dev/null
actual_id=$(docker run --rm --network none --user 70:70 --env LC_ALL=C --mount "type=volume,source=$existing,target=/fixture,readonly" --entrypoint pg_controldata "$image" /fixture/pgdata |
 awk -F: '/^Database system identifier:/ {gsub(/[[:space:]]/,"",$2); print $2}')
[[ "$actual_id" =~ ^[0-9]{1,20}$ ]]
check "$existing" upgrade "$actual_id"
expect_failure check "$existing" upgrade 1
expect_failure check "$existing" new
# The existing staging layout must not be mistaken for the production layout,
# even when a valid-looking pgdata directory is also present.
docker run --rm --network none --user root --mount "type=volume,source=$existing,target=/fixture" --entrypoint /bin/sh "$image" -c 'printf 17 > /fixture/PG_VERSION'
expect_failure check "$existing" upgrade "$actual_id"
printf 'Production volume preflight passed: empty new volume, identified cluster, wrong ID and root-level cluster checks.\n'
