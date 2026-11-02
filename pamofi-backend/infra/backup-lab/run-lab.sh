#!/usr/bin/env bash
# Disposable, offline-only physical backup and WAL restore exercise.
set -euo pipefail
lab_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
backend_dir=$(cd -- "$lab_dir/../.." && pwd)
lab_id=$(openssl rand -hex 8)
prefix="pamofi-backup-lab-$lab_id"
image='pamofi-backup-lab:2.57.0'
source_name="$prefix-source"
restore_name="$prefix-restored"
source_volume="$prefix-source-data"
restore_volume="$prefix-restored-data"
repo_volume="$prefix-repository"
lab_key=$(openssl rand -hex 32)
created_volumes=()
created_containers=()
cleanup() {
 local status=$?
 trap - EXIT
 set +u
 if (( status != 0 )); then
  printf 'Backup lab failed; showing disposable container diagnostics.\n' >&2
  for name in "${created_containers[@]}"; do docker logs --tail 20 "$name" >&2 2>/dev/null || true; done
 fi
 for name in "${created_containers[@]}"; do docker rm -f "$name" >/dev/null 2>&1 || true; done
 for name in "${created_volumes[@]}"; do docker volume rm "$name" >/dev/null 2>&1 || true; done
 exit "$status"
}
trap cleanup EXIT
for name in "$source_volume" "$restore_volume" "$repo_volume"; do
 if docker volume inspect "$name" >/dev/null 2>&1; then printf 'Unexpected existing lab volume: %s\n' "$name" >&2; exit 1; fi
 docker volume create --label "com.pamofi.backup-lab=$lab_id" "$name" >/dev/null
 created_volumes+=("$name")
done
docker build --quiet -t "$image" "$lab_dir" >/dev/null
# Initialize only these newly created volumes. There is no network and no published port.
docker run --rm --network none --user root -v "$source_volume:/var/lib/postgresql/data" -v "$repo_volume:/var/lib/pgbackrest" "$image" sh -c 'chown postgres:postgres /var/lib/postgresql/data /var/lib/pgbackrest'
docker run --rm --network none --user root -v "$restore_volume:/var/lib/postgresql/data" "$image" sh -c 'chown postgres:postgres /var/lib/postgresql/data'
docker run -d --name "$source_name" --network none \
 -e POSTGRES_PASSWORD=disposable-lab-only -e PGDATA=/var/lib/postgresql/data/pgdata \
 -e PGBACKREST_REPO1_CIPHER_PASS="$lab_key" \
 -v "$source_volume:/var/lib/postgresql/data" -v "$repo_volume:/var/lib/pgbackrest" \
 "$image" postgres -c archive_mode=on -c "archive_command=pgbackrest --stanza=pamofi-lab archive-push %p" -c wal_level=replica >/dev/null
created_containers+=("$source_name")
wait_ready() {
 local name=$1
 for ((i=0;i<90;i++)); do
  # The image starts a temporary socket-only server during initialization; wait
  # for the final TCP listener, not the short-lived initialization server.
  if docker exec "$name" pg_isready -h 127.0.0.1 -U postgres -d postgres >/dev/null 2>&1; then return 0; fi
  sleep 1
 done
 printf '%s did not become ready\n' "$name" >&2; return 1
}
wait_ready "$source_name"
docker exec --user postgres "$source_name" pgbackrest --stanza=pamofi-lab stanza-create
# Use the real service-owned databases and schema migrations, but only disposable fixtures.
docker exec -i "$source_name" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < "$backend_dir/infra/postgres/init.sql" >/dev/null
for service in identity prepaid-access network notification assistant; do
 case "$service" in prepaid-access) db=pamofi_prepaid_access;; *) db="pamofi_${service}";; esac
 docker exec "$source_name" psql -X -v ON_ERROR_STOP=1 -U "$db" -d "$db" -c 'CREATE TABLE schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())' >/dev/null
 for migration in "$backend_dir/services/$service-service/migrations/"*.sql; do
  migration_name=${migration##*/}
  [[ "$migration_name" =~ ^[0-9]+_[a-z0-9_]+\.sql$ ]] || { printf 'Invalid migration name\n' >&2; exit 1; }
  checksum=$(openssl dgst -sha256 -r "$migration" | awk '{print $1}')
  { printf 'BEGIN;\n'; cat "$migration"; printf "\nINSERT INTO schema_migrations(name,checksum) VALUES ('%s','%s');\nCOMMIT;\n" "$migration_name" "$checksum"; } |
   docker exec -i "$source_name" psql -X -v ON_ERROR_STOP=1 -U "$db" -d "$db" >/dev/null
 done
done
docker exec -i "$source_name" psql -X -v ON_ERROR_STOP=1 -U pamofi_identity -d pamofi_identity >/dev/null <<'SQL'
INSERT INTO customers(id) VALUES('11111111-1111-4111-8111-111111111111');
INSERT INTO customer_sessions(token_hash,customer_id,expires_at) VALUES(decode(repeat('a0',32),'hex'),'11111111-1111-4111-8111-111111111111',now()+interval '30 days');
INSERT INTO customer_session_creations(request_hash,session_token_hash) VALUES(decode(repeat('b0',32),'hex'),decode(repeat('a0',32),'hex'));
SQL
docker exec -i "$source_name" psql -X -v ON_ERROR_STOP=1 -U pamofi_prepaid_access -d pamofi_prepaid_access >/dev/null <<'SQL'
INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at)
 VALUES('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','lab-recovery-key-001','flex',100,'USD',5000000000,604800,'payment_confirmed',now()+interval '1 hour');
INSERT INTO purchase_entitlements(id,order_id,customer_id,bundle_id,byte_limit,validity_seconds,start_by)
 VALUES('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','flex',5000000000,604800,now()+interval '30 days');
INSERT INTO access_grants(id,customer_id,entitlement_id,site_id,nas_id,request_key,generation,state,reserved_bytes,deadline,accounting_session_id)
 VALUES('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777','88888888-8888-4888-8888-888888888888','uncertain',5000000000,now()+interval '1 hour','lab-session');
SQL
printf 'Creating encrypted full-cluster backup...\n'
docker exec --user postgres "$source_name" pgbackrest --stanza=pamofi-lab --type=full backup
docker exec --user postgres "$source_name" pgbackrest --stanza=pamofi-lab check
if wrong_key_output=$(docker exec --user postgres -e PGBACKREST_REPO1_CIPHER_PASS=incorrect "$source_name" pgbackrest --stanza=pamofi-lab check 2>&1); then
 printf 'Backup unexpectedly accepted the wrong encryption key\n' >&2; exit 1
fi
if [[ "$wrong_key_output" != *'CryptoError'* && "$wrong_key_output" != *'CipherError'* && "$wrong_key_output" != *'FormatError'* ]]; then
 printf 'The wrong-key check failed for a reason other than decryption:\n%s\n' "$wrong_key_output" >&2; exit 1
fi
# This transaction occurs after the full backup and must be recovered from WAL.
docker exec -i "$source_name" psql -X -v ON_ERROR_STOP=1 -U pamofi_prepaid_access -d pamofi_prepaid_access >/dev/null <<'SQL'
BEGIN;
UPDATE purchase_entitlements SET consumed_bytes=12345 WHERE id='33333333-3333-4333-8333-333333333333';
UPDATE access_grants SET charged_bytes=12345, upload_high=12345 WHERE id='44444444-4444-4444-8444-444444444444';
INSERT INTO event_outbox(id,event_type,event_version,aggregate_id,aggregate_version,correlation_id,payload)
 VALUES('99999999-9999-4999-8999-999999999999','lab.restored',1,'33333333-3333-4333-8333-333333333333',1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','{}');
COMMIT;
SQL
wal=$(docker exec "$source_name" psql -X -A -t -U postgres -d postgres -c 'SELECT pg_walfile_name(pg_switch_wal())' | tr -d '\r\n')
for ((i=0;i<90;i++)); do
 archived=$(docker exec "$source_name" psql -X -A -t -U postgres -d postgres -c "SELECT COALESCE(last_archived_wal,'') FROM pg_stat_archiver" 2>/dev/null | tr -d '\r\n' || true)
 [[ "$archived" == "$wal" ]] && break
 sleep 1
done
if [[ "$archived" != "$wal" ]]; then printf 'WAL segment did not archive: %s\n' "$wal" >&2; exit 1; fi
# Simulated fence: stop the disposable old server before the restore can start.
docker stop --time 30 "$source_name" >/dev/null
[[ $(docker inspect -f '{{.State.Running}}' "$source_name") == false ]]
printf 'Restoring into a separate isolated volume...\n'
docker run --rm --network none --user postgres -e PGBACKREST_REPO1_CIPHER_PASS="$lab_key" \
 -v "$restore_volume:/var/lib/postgresql/data" -v "$repo_volume:/var/lib/pgbackrest:ro" \
 "$image" pgbackrest --stanza=pamofi-lab restore
docker run -d --name "$restore_name" --network none \
 -e PGDATA=/var/lib/postgresql/data/pgdata -e PGBACKREST_REPO1_CIPHER_PASS="$lab_key" \
 -v "$restore_volume:/var/lib/postgresql/data" -v "$repo_volume:/var/lib/pgbackrest:ro" \
 "$image" postgres -c archive_mode=off >/dev/null
created_containers+=("$restore_name")
wait_ready "$restore_name"
actual=$(docker exec "$restore_name" psql -X -A -t -v ON_ERROR_STOP=1 -U pamofi_prepaid_access -d pamofi_prepaid_access -c "SELECT e.consumed_bytes::text||':'||g.charged_bytes::text||':'||g.state||':'||(SELECT count(*) FROM event_outbox WHERE id='99999999-9999-4999-8999-999999999999' AND status='pending') FROM purchase_entitlements e JOIN access_grants g ON g.entitlement_id=e.id WHERE e.id='33333333-3333-4333-8333-333333333333'" | tr -d '\r\n')
[[ "$actual" == '12345:12345:uncertain:1' ]] || { printf 'Restored grant/ledger/outbox invariant failed: %s\n' "$actual" >&2; exit 1; }
if duplicate_output=$(docker exec "$restore_name" psql -X -v ON_ERROR_STOP=1 -U pamofi_prepaid_access -d pamofi_prepaid_access -c "INSERT INTO access_grants(id,customer_id,entitlement_id,site_id,nas_id,request_key,generation,state,reserved_bytes,deadline,accounting_session_id) SELECT 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',customer_id,entitlement_id,site_id,nas_id,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','dddddddd-dddd-4ddd-8ddd-dddddddddddd','pending',reserved_bytes,now()+interval '1 hour','another-lab-session' FROM access_grants WHERE id='44444444-4444-4444-8444-444444444444'" 2>&1); then
 printf 'Restored database allowed a second live grant\n' >&2; exit 1
fi
if [[ "$duplicate_output" != *'one_live_or_uncertain_grant_per_customer'* ]]; then
 printf 'The duplicate-grant check failed for an unexpected reason\n' >&2; exit 1
fi
identity=$(docker exec "$restore_name" psql -X -A -t -v ON_ERROR_STOP=1 -U pamofi_identity -d pamofi_identity -c "SELECT count(*) FROM customers WHERE id='11111111-1111-4111-8111-111111111111'" | tr -d '\r\n')
[[ "$identity" == 1 ]]
session=$(docker exec "$restore_name" psql -X -A -t -v ON_ERROR_STOP=1 -U pamofi_identity -d pamofi_identity -c "SELECT count(*) FROM customer_session_creations c JOIN customer_sessions s ON s.token_hash=c.session_token_hash WHERE c.request_hash=decode(repeat('b0',32),'hex') AND s.customer_id='11111111-1111-4111-8111-111111111111'" | tr -d '\r\n')
[[ "$session" == 1 ]] || { printf 'Restored session retry record missing\n' >&2; exit 1; }
for db in pamofi_identity pamofi_prepaid_access pamofi_network pamofi_notification pamofi_assistant; do
 count=$(docker exec "$restore_name" psql -X -A -t -v ON_ERROR_STOP=1 -U "$db" -d "$db" -c 'SELECT count(*) FROM schema_migrations' | tr -d '\r\n')
 [[ "$count" =~ ^[1-9][0-9]*$ ]] || { printf 'Missing restored migration ledger for %s\n' "$db" >&2; exit 1; }
done
if docker exec "$restore_name" psql -X -U pamofi_identity -d pamofi_prepaid_access -c 'SELECT 1' >/dev/null 2>&1; then
 printf 'Restored cross-service database isolation failed\n' >&2; exit 1
fi
printf 'PASS: encrypted full backup, wrong-key rejection, WAL recovery, isolated restore, five databases and stopped old server.\n'
