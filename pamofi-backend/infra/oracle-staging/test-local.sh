#!/usr/bin/env bash
# Disposable local check of the private staging configuration. Never use a real database.
set -Eeuo pipefail
cd "$(dirname "$0")"
backend=$(cd ../.. && pwd)
stage_temp=$(mktemp -d "${TMPDIR:-/tmp}/pamofi-stage-test.XXXXXXXX")
chmod 700 "$stage_temp"
stage_release=$(basename "$stage_temp" | tr '[:upper:].' '[:lower:]-')
stage_project="pamofi-$stage_release"
cleanup() {
 docker compose --env-file "$stage_temp/.env" -p "$stage_project" down --volumes --remove-orphans >/dev/null 2>&1 || true
 for service in identity prepaid-access network notification assistant; do docker image rm "pamofi-staging-$service:$stage_release" >/dev/null 2>&1 || true; done
 rm -rf -- "$stage_temp"
}
trap cleanup EXIT
umask 077
for key in POSTGRES_PASSWORD IDENTITY_DB_PASSWORD PREPAID_DB_PASSWORD NETWORK_DB_PASSWORD NOTIFICATION_DB_PASSWORD ASSISTANT_DB_PASSWORD INTERNAL_IDENTITY_SECRET INTERNAL_EVENTS_SECRET SESSION_CREATION_SECRET; do
 printf '%s=%s\n' "$key" "$(openssl rand -hex 32)" >> "$stage_temp/.env"
done
printf 'PAMOFI_RELEASE=%s\n' "$stage_release" >> "$stage_temp/.env"
compose() { docker compose --env-file "$stage_temp/.env" -p "$stage_project" "$@"; }
for service in identity prepaid-access network notification assistant; do
 docker build -t "pamofi-staging-$service:$stage_release" "$backend/services/$service-service" > "$stage_temp/build-$service.log" 2>&1 || { echo "Image build failed: $service" >&2; exit 1; }
done
# PostgreSQL drops to UID 70 before executing initialization scripts. Check the
# actual bind mount as that user before it can initialize a persistent volume.
compose run --rm --no-deps --user 70:70 --entrypoint /bin/sh postgres -c 'test -r /docker-entrypoint-initdb.d/10-pamofi.sh && test -x /docker-entrypoint-initdb.d/10-pamofi.sh' > "$stage_temp/permissions.log" 2>&1 || { echo 'Database initializer is not readable and executable by PostgreSQL' >&2; exit 1; }
compose up -d --wait postgres > "$stage_temp/postgres.log" 2>&1 || { echo 'Staging database failed to initialize' >&2; exit 1; }
for service in identity prepaid-access network notification assistant; do
 compose run --rm --no-deps "$service" node migrate.mjs > "$stage_temp/migrate-$service.log" 2>&1 || { echo "Migration failed: $service" >&2; exit 1; }
done
compose up -d --no-build > "$stage_temp/up.log" 2>&1
for service in identity prepaid-access network notification assistant; do
 for attempt in $(seq 1 30); do
  if compose exec -T "$service" node -e 'fetch("http://127.0.0.1:3000/health/ready").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then break; fi
  if [ "$attempt" = 30 ]; then echo "Readiness failed: $service" >&2; exit 1; fi
  sleep 1
 done
 bindings=$(docker inspect "$(compose ps -q "$service")" --format '{{json .HostConfig.PortBindings}}')
 test "$bindings" = null || test "$bindings" = '{}'
done
compose exec -T prepaid-access node -e 'fetch("http://127.0.0.1:3000/v1/bundles").then(r=>r.json()).then(x=>process.exit(x.candidate===false && Array.isArray(x.products) && x.products.length===0?0:1)).catch(()=>process.exit(1))'
compose exec -T prepaid-access node -e 'fetch("http://127.0.0.1:3000/v1/orders",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({bundleId:"flex"})}).then(r=>process.exit(r.status===404?0:1)).catch(()=>process.exit(1))'
# A runtime role must not connect to another service's database.
if compose exec -T postgres sh -c 'PGPASSWORD="$IDENTITY_DB_PASSWORD" psql -h 127.0.0.1 -U pamofi_identity -d pamofi_prepaid_access -c "select 1" >/dev/null 2>&1'; then
 echo 'Cross-service database isolation failed' >&2;exit 1
fi
printf 'Private staging test passed: five services ready, catalogue unpublished, mock payment disabled, database isolation enforced.\n'
