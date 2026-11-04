#!/usr/bin/env bash
# Disposable real-PostgreSQL check for the production initialization gate.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
container_id=''
cleanup() {
  result=$?
  if [ "$result" -ne 0 ] && [ -n "$container_id" ]; then docker logs --tail 25 "$container_id" >&2 2>/dev/null || true; fi
  if [ -n "$container_id" ]; then docker rm -f "$container_id" >/dev/null 2>&1 || true; fi
  exit "$result"
}
trap cleanup EXIT
container_id=$(docker run -d --network none -e POSTGRES_USER=pamofi_bootstrap -e POSTGRES_PASSWORD=disposable_readiness_only -e POSTGRES_DB=postgres \
  --mount "type=bind,source=$here/postgres-ready.sh,target=/opt/pamofi/postgres-ready.sh,readonly" \
  --mount "type=bind,source=$here/postgres-ready.sql,target=/opt/pamofi/postgres-ready.sql,readonly" \
  postgres:17.11-alpine3.23@sha256:2ad58d61b036d41f2613302e8c0fee03f6fe51e94d68087327ac45d1cebd4b5e)
for attempt in $(seq 1 60); do
  if docker exec "$container_id" pg_isready -h 127.0.0.1 -U pamofi_bootstrap -d postgres >/dev/null 2>&1; then break; fi
  if [ "$attempt" = 60 ]; then echo 'Disposable PostgreSQL failed to start' >&2; exit 1; fi
  sleep 1
done
if docker exec "$container_id" sh /opt/pamofi/postgres-ready.sh; then
  echo 'Uninitialized database incorrectly reported ready' >&2; exit 1
fi
# Synthetic identities only: create the same role and database names as init.sh.
for suffix in identity prepaid_access network notification assistant; do
  docker exec "$container_id" psql -Xq -v ON_ERROR_STOP=1 -U pamofi_bootstrap -d postgres \
    -c "CREATE ROLE pamofi_${suffix}_owner NOLOGIN" \
    -c "CREATE ROLE pamofi_${suffix}_migrate LOGIN" \
    -c "CREATE ROLE pamofi_${suffix}_runtime LOGIN" \
    -c "GRANT pamofi_${suffix}_owner TO pamofi_${suffix}_migrate" \
    -c "CREATE DATABASE pamofi_${suffix} OWNER pamofi_${suffix}_owner" \
    -c "REVOKE ALL ON DATABASE pamofi_${suffix} FROM PUBLIC" \
    -c "GRANT CONNECT ON DATABASE pamofi_${suffix} TO pamofi_${suffix}_migrate, pamofi_${suffix}_runtime"
done
docker exec "$container_id" sh /opt/pamofi/postgres-ready.sh
# Even a single missing role or wrongly configured login must fail the gate.
docker exec "$container_id" psql -Xq -v ON_ERROR_STOP=1 -U pamofi_bootstrap -d postgres -c 'REVOKE CONNECT ON DATABASE pamofi_network FROM pamofi_network_runtime' -c 'DROP ROLE pamofi_network_runtime'
if docker exec "$container_id" sh /opt/pamofi/postgres-ready.sh; then
  echo 'Database with missing role incorrectly reported ready' >&2; exit 1
fi
docker exec "$container_id" psql -Xq -v ON_ERROR_STOP=1 -U pamofi_bootstrap -d postgres -c 'CREATE ROLE pamofi_network_runtime NOLOGIN' -c 'GRANT CONNECT ON DATABASE pamofi_network TO pamofi_network_runtime'
if docker exec "$container_id" sh /opt/pamofi/postgres-ready.sh; then
  echo 'Database with invalid login role incorrectly reported ready' >&2; exit 1
fi
docker exec "$container_id" psql -Xq -v ON_ERROR_STOP=1 -U pamofi_bootstrap -d postgres -c 'ALTER ROLE pamofi_network_runtime LOGIN'
docker exec "$container_id" sh /opt/pamofi/postgres-ready.sh
docker exec "$container_id" psql -Xq -v ON_ERROR_STOP=1 -U pamofi_bootstrap -d postgres -c 'REVOKE pamofi_network_owner FROM pamofi_network_migrate'
if docker exec "$container_id" sh /opt/pamofi/postgres-ready.sh; then
  echo 'Database with missing owner membership incorrectly reported ready' >&2; exit 1
fi
docker exec "$container_id" psql -Xq -v ON_ERROR_STOP=1 -U pamofi_bootstrap -d postgres -c 'GRANT pamofi_network_owner TO pamofi_network_migrate' -c 'REVOKE CONNECT ON DATABASE pamofi_network FROM pamofi_network_runtime'
if docker exec "$container_id" sh /opt/pamofi/postgres-ready.sh; then
  echo 'Database with missing connection privilege incorrectly reported ready' >&2; exit 1
fi
docker exec "$container_id" psql -Xq -v ON_ERROR_STOP=1 -U pamofi_bootstrap -d postgres -c 'GRANT CONNECT ON DATABASE pamofi_network TO pamofi_network_runtime'
docker exec "$container_id" sh /opt/pamofi/postgres-ready.sh
printf '%s\n' 'Production PostgreSQL readiness passed: incomplete and invalid installations rejected; complete existing-style installation accepted.'
