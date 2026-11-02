#!/bin/bash
set -euo pipefail
umask 077
tmp=$(mktemp -d /tmp/pamofi-restore-units.XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT
for p in /usr/local/sbin/pamofi-restore-drill /etc/systemd/system/pamofi-restore-drill.service /etc/systemd/system/pamofi-restore-drill.timer; do [ ! -e "$p" ] || { echo "Existing PamoFi restore scheduler file; refusing overwrite: $p" >&2; exit 1; }; done
cat > "$tmp/pamofi-restore-drill" <<'EOF'
#!/bin/bash
set -euo pipefail
umask 077
exec 9>/run/lock/pamofi-backup.lock
flock -w 900 9 || { echo 'PamoFi restore job lock timed out' >&2; exit 1; }
root=/home/ubuntu/pamofi/production
creds="$root/secrets"
image=pamofi-postgres-backup:17.11-2.57.0
id=$(openssl rand -hex 5)
volume="pamofi-auto-restore-$id"
network="pamofi-auto-restore-$id"
restore="pamofi-auto-restore-$id-fetch"
server="pamofi-auto-restore-$id-server"
volume_created=false
network_created=false
cleanup() {
 result=$?
 trap - EXIT
 docker rm -f "$restore" "$server" >/dev/null 2>&1 || true
 if [ "$volume_created" = true ]; then docker volume rm "$volume" >/dev/null 2>&1 || true; fi
 if [ "$network_created" = true ]; then docker network rm "$network" >/dev/null 2>&1 || true; fi
 exit "$result"
}
trap cleanup EXIT
for f in b2_key_id b2_application_key backup_cipher; do [ -s "$creds/$f" ]; done
expected_id=$(cat "$root/cluster-system-id")
[[ "$expected_id" =~ ^[0-9]+$ ]]
docker network inspect $(docker network ls -q) --format '{{range .IPAM.Config}}{{println .Subnet}}{{end}}' | python3 -c 'import ipaddress,sys; n=ipaddress.ip_network("10.245.244.0/24"); assert all(not n.overlaps(ipaddress.ip_network(x.strip())) for x in sys.stdin if x.strip()), "Restore drill subnet overlaps an existing network"'
ip -j -4 route show table all | python3 -c 'import ipaddress,json,sys; n=ipaddress.ip_network("10.245.244.0/24"); assert all(not n.overlaps(ipaddress.ip_network(r["dst"],strict=False)) for r in json.load(sys.stdin) if r.get("dst","default") != "default"), "Restore drill subnet overlaps a host route"'
docker volume create --label pamofi.purpose=monthly-restore-drill "$volume" >/dev/null
volume_created=true
docker network create --label pamofi.purpose=monthly-restore-drill --subnet 10.245.244.0/24 "$network" >/dev/null
network_created=true
docker run --rm --network none --user root --mount "type=volume,source=$volume,target=/var/lib/postgresql/data" --entrypoint sh "$image" -c 'chown postgres:postgres /var/lib/postgresql/data'
common=(--network "$network" --cpus 0.35 --memory 512m --pids-limit 150 --tmpfs /run/pgbackrest -e B2_BUCKET=pamofi-b2-blazebucket -e B2_REGION=eu-central-003 -e BACKUP_REPOSITORY_PREFIX=/pamofi-production -e B2_KEY_ID_FILE=/run/secrets/b2_key_id -e B2_APPLICATION_KEY_FILE=/run/secrets/b2_application_key -e BACKUP_CIPHER_FILE=/run/secrets/backup_cipher -e PGDATA=/var/lib/postgresql/data/pgdata --mount "type=bind,source=$creds/b2_key_id,target=/run/secrets/b2_key_id,readonly" --mount "type=bind,source=$creds/b2_application_key,target=/run/secrets/b2_application_key,readonly" --mount "type=bind,source=$creds/backup_cipher,target=/run/secrets/backup_cipher,readonly" --mount "type=volume,source=$volume,target=/var/lib/postgresql/data")
docker run --rm --name "$restore" "${common[@]}" "$image" su postgres -s /bin/sh -c 'pgbackrest --stanza=pamofi restore'
docker run -d --name "$server" "${common[@]}" "$image" postgres -c archive_mode=off -c listen_addresses= >/dev/null
ready=false
for ((i=0; i<180; i++)); do if docker exec "$server" pg_isready -U pamofi_bootstrap -d postgres >/dev/null 2>&1; then ready=true; break; fi; sleep 1; done
[ "$ready" = true ] || { echo 'Restore drill database did not become ready.' >&2; exit 1; }
actual_id=$(docker exec -u postgres "$server" pg_controldata /var/lib/postgresql/data/pgdata | awk -F: '/^Database system identifier:/ {gsub(/[[:space:]]/,"",$2); print $2}')
[ "$actual_id" = "$expected_id" ] || { echo 'Restore drill cluster identity mismatch.' >&2; exit 1; }
count=$(docker exec -u postgres "$server" psql -X -U pamofi_bootstrap -d postgres -At -c "SELECT count(*) FROM pg_database WHERE datname IN ('pamofi_identity','pamofi_prepaid_access','pamofi_network','pamofi_notification','pamofi_assistant')" | tr -d '\r\n')
[ "$count" = 5 ] || { echo 'Restore drill database count mismatch.' >&2; exit 1; }
for db in pamofi_identity pamofi_prepaid_access pamofi_network pamofi_notification pamofi_assistant; do count=$(docker exec -u postgres "$server" psql -X -U pamofi_bootstrap -d "$db" -At -c 'SELECT count(*) FROM schema_migrations' | tr -d '\r\n'); [[ "$count" =~ ^[1-9][0-9]*$ ]] || { echo "Restore drill missing migration ledger: $db" >&2; exit 1; }; done
printf 'PASS: remote backup restored into a disposable volume with the expected cluster ID and all five migration ledgers.\n'
EOF
cat > "$tmp/pamofi-restore-drill.service" <<'EOF'
[Unit]
Description=PamoFi isolated backup restore drill
After=docker.service network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/pamofi-restore-drill
TimeoutStartSec=4h
Nice=10
NoNewPrivileges=yes
EOF
cat > "$tmp/pamofi-restore-drill.timer" <<'EOF'
[Unit]
Description=PamoFi monthly isolated backup restore drill
[Timer]
OnCalendar=*-*-08 04:30:00 UTC
RandomizedDelaySec=15m
Persistent=true
Unit=pamofi-restore-drill.service
[Install]
WantedBy=timers.target
EOF
bash -n "$tmp/pamofi-restore-drill"
systemd-analyze calendar '*-*-08 04:30:00 UTC' >/dev/null
sudo -n install -o root -g root -m 0755 "$tmp/pamofi-restore-drill" /usr/local/sbin/pamofi-restore-drill
sudo -n install -o root -g root -m 0644 "$tmp/pamofi-restore-drill.service" /etc/systemd/system/pamofi-restore-drill.service
sudo -n install -o root -g root -m 0644 "$tmp/pamofi-restore-drill.timer" /etc/systemd/system/pamofi-restore-drill.timer
sudo -n systemd-analyze verify /etc/systemd/system/pamofi-restore-drill.service /etc/systemd/system/pamofi-restore-drill.timer
sudo -n systemctl daemon-reload </dev/null
sudo -n systemctl enable --now pamofi-restore-drill.timer </dev/null
sudo -n systemctl list-timers --all --no-legend pamofi-restore-drill.timer
printf 'Monthly PamoFi restore drill timer installed; external alert delivery remains unconfigured.\n'
