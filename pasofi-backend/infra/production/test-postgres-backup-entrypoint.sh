#!/usr/bin/env bash
# Check the actual production backup image through the production startup wrapper.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/pamofi-backup-entrypoint.XXXXXXXX")
id=$(openssl rand -hex 8)
image="pamofi-backup-entrypoint-test:$id"
container="pamofi-backup-entrypoint-test-$id"
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then docker logs --tail 30 "$container" >&2 2>/dev/null || true; fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$result"
}
trap cleanup EXIT
chmod 755 "$work"
printf '#!/bin/sh\nexit 0\n' > "$work/init.sh"
printf 'synthetic-key-id\n' > "$work/key-id"
printf 'synthetic-application-key-only\n' > "$work/application-key"
printf 'synthetic-cipher-password-for-test-only\n' > "$work/cipher"
docker build --quiet -t "$image" "$here/../backup-production" >/dev/null
docker run -d --name "$container" --network none --entrypoint /bin/sh \
  -e POSTGRES_USER=pamofi_bootstrap -e POSTGRES_PASSWORD=disposable-test-only \
  -e B2_BUCKET=synthetic-test -e B2_REGION=us-west-001 -e BACKUP_REPOSITORY_PREFIX=/test \
  -e B2_KEY_ID_FILE=/fixture/key-id -e B2_APPLICATION_KEY_FILE=/fixture/application-key -e BACKUP_CIPHER_FILE=/fixture/cipher \
  -v "$work:/fixture:ro" -v "$work/init.sh:/opt/pamofi/init.sh:ro" \
  -v "$here/postgres-entrypoint.sh:/opt/pamofi/postgres-entrypoint.sh:ro" \
  "$image" /opt/pamofi/postgres-entrypoint.sh postgres >/dev/null
for attempt in $(seq 1 90); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U pamofi_bootstrap -d postgres >/dev/null 2>&1; then break; fi
  if [ "$attempt" = 90 ]; then echo 'Backup-image PostgreSQL failed to start.' >&2; exit 1; fi
  sleep 1
done
docker exec --user postgres "$container" test -r /run/pgbackrest/pgbackrest.conf
[[ $(docker exec "$container" stat -c '%a:%U' /run/pgbackrest/pgbackrest.conf | tr -d '\r\n') == '600:postgres' ]]
docker exec "$container" test -x /docker-entrypoint-initdb.d/10-pamofi.sh
# A configuration declaring backups cannot start with a plain image that lacks
# the backup wrapper. This must fail rather than silently disabling archiving.
if missing_output=$(docker run --rm --network none --entrypoint /bin/sh -e PGBACKREST_CONFIG=/tmp/required \
  -v "$work/init.sh:/opt/pamofi/init.sh:ro" \
  -v "$here/postgres-entrypoint.sh:/opt/pamofi/postgres-entrypoint.sh:ro" \
  postgres:17.11-alpine3.23@sha256:2ad58d61b036d41f2613302e8c0fee03f6fe51e94d68087327ac45d1cebd4b5e \
  /opt/pamofi/postgres-entrypoint.sh postgres 2>&1); then
  echo 'PostgreSQL started with a missing required backup wrapper.' >&2; exit 1
fi
[[ "$missing_output" == *'Backup configuration is set but the backup entrypoint is missing.'* ]] || {
  echo 'Missing-wrapper check failed for an unexpected reason.' >&2; exit 1;
}
printf '%s\n' 'Production backup entrypoint passed: private configuration rendered and missing wrapper rejected.'
