#!/usr/bin/env bash
# Exercise the actual lab health command while PostgreSQL is deliberately
# running its temporary, socket-only initialization server.
set -euo pipefail
cd "$(dirname "$0")"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/pamofi-pg-ready.XXXXXXXX")
container_id=''
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -n "$container_id" ]; then
    docker logs --tail 30 "$container_id" >&2 2>/dev/null || true
  fi
  if [ -n "$container_id" ]; then docker rm -f "$container_id" >/dev/null 2>&1 || true; fi
  rm -rf -- "$fixture"
  exit "$status"
}
trap 'cleanup' EXIT
cat > "$fixture/00-delayed-init.sh" <<'SH'
#!/bin/sh
set -eu
touch /tmp/pamofi-lab-init-in-progress
while [ ! -f /tmp/pamofi-lab-init-continue ]; do sleep 1; done
SH
chmod 755 "$fixture/00-delayed-init.sh"
healthcheck=$(LAB_CERT_DIR="$fixture" LAB_CLIENT_FINGERPRINT=fixture LAB_SUBNET=10.254.253.0/24 LAB_NAS_A_IP=10.254.253.10 LAB_NAS_B_IP=10.254.253.11 \
 docker compose config --format json | python3 -c 'import json,sys; test=json.load(sys.stdin)["services"]["postgres"]["healthcheck"]["test"]; assert len(test)==2 and test[0]=="CMD-SHELL"; print(test[1])')
container_id=$(docker run -d --network none -e POSTGRES_USER=pamofi_bootstrap -e POSTGRES_PASSWORD=disposable_readiness_only -e POSTGRES_DB=postgres \
 -v "$fixture/00-delayed-init.sh:/docker-entrypoint-initdb.d/00-delayed-init.sh:ro" postgres:17.11-alpine3.23)
for attempt in $(seq 1 60); do
  if docker exec "$container_id" test -f /tmp/pamofi-lab-init-in-progress >/dev/null 2>&1; then break; fi
  if [ "$attempt" = 60 ]; then echo 'PostgreSQL initialization did not start' >&2; exit 1; fi
  sleep 1
done
# The socket probe accepts the temporary server; the configured probe must not.
docker exec "$container_id" pg_isready -U pamofi_bootstrap -d postgres >/dev/null
if docker exec "$container_id" sh -c "$healthcheck" >/dev/null 2>&1; then
  echo 'Lab health check accepted the temporary PostgreSQL initializer' >&2; exit 1
fi
docker exec "$container_id" touch /tmp/pamofi-lab-init-continue
final_ready=false
for attempt in $(seq 1 60); do
  if docker exec "$container_id" sh -c "$healthcheck" >/dev/null 2>&1; then
    echo 'PostgreSQL readiness test passed: initializer rejected; final TCP server accepted.'
    final_ready=true
    break
  fi
  sleep 1
done
if [ "$final_ready" != true ]; then
  echo 'PostgreSQL final server did not become ready' >&2
  exit 1
fi
