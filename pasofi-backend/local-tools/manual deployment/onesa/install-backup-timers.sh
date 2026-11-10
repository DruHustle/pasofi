#!/bin/bash
set -euo pipefail
umask 077
tmp=$(mktemp -d /tmp/pamofi-backup-units.XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT
for p in /usr/local/sbin/pamofi-backup-run /etc/systemd/system/pamofi-backup@.service /etc/systemd/system/pamofi-backup-full.timer /etc/systemd/system/pamofi-backup-diff.timer /etc/systemd/system/pamofi-backup-check.timer; do
 [ ! -e "$p" ] || { echo "Existing PamoFi scheduler file; refusing overwrite: $p" >&2; exit 1; }
done
cat > "$tmp/pamofi-backup-run" <<'EOF'
#!/bin/bash
set -euo pipefail
case "${1:-}" in full|diff|check) kind=$1;; *) echo 'Invalid PamoFi backup job' >&2; exit 2;; esac
exec 9>/run/lock/pamofi-backup.lock
flock -w 900 9 || { echo 'PamoFi backup job lock timed out' >&2; exit 1; }
if [ "$kind" = check ]; then
 /usr/bin/docker exec -u postgres pamofi-production-postgres-1 pgbackrest --stanza=pamofi check
else
 /usr/bin/docker exec -u postgres pamofi-production-postgres-1 pgbackrest --stanza=pamofi --type="$kind" backup
 /usr/bin/docker exec -u postgres pamofi-production-postgres-1 pgbackrest --stanza=pamofi check
fi
EOF
cat > "$tmp/pamofi-backup@.service" <<'EOF'
[Unit]
Description=pasofi encrypted backup %i
After=docker.service network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/pamofi-backup-run %i
TimeoutStartSec=4h
Nice=10
NoNewPrivileges=yes
EOF
cat > "$tmp/pamofi-backup-full.timer" <<'EOF'
[Unit]
Description=pasofi weekly full backup
[Timer]
OnCalendar=Sun *-*-* 01:15:00 UTC
RandomizedDelaySec=15m
Persistent=true
Unit=pamofi-backup@full.service
[Install]
WantedBy=timers.target
EOF
cat > "$tmp/pamofi-backup-diff.timer" <<'EOF'
[Unit]
Description=pasofi daily differential backup
[Timer]
OnCalendar=Mon..Sat *-*-* 02:15:00 UTC
RandomizedDelaySec=15m
Persistent=true
Unit=pamofi-backup@diff.service
[Install]
WantedBy=timers.target
EOF
cat > "$tmp/pamofi-backup-check.timer" <<'EOF'
[Unit]
Description=pasofi hourly backup health check
[Timer]
OnCalendar=*-*-* *:10:00 UTC
RandomizedDelaySec=5m
Persistent=true
Unit=pamofi-backup@check.service
[Install]
WantedBy=timers.target
EOF
bash -n "$tmp/pamofi-backup-run"
systemd-analyze calendar 'Sun *-*-* 01:15:00 UTC' 'Mon..Sat *-*-* 02:15:00 UTC' '*-*-* *:10:00 UTC' >/dev/null
sudo -n install -o root -g root -m 0755 "$tmp/pamofi-backup-run" /usr/local/sbin/pamofi-backup-run
sudo -n install -o root -g root -m 0644 "$tmp/pamofi-backup@.service" /etc/systemd/system/pamofi-backup@.service
for kind in full diff check; do sudo -n install -o root -g root -m 0644 "$tmp/pamofi-backup-$kind.timer" "/etc/systemd/system/pamofi-backup-$kind.timer"; done
sudo -n systemd-analyze verify /etc/systemd/system/pamofi-backup@.service /etc/systemd/system/pamofi-backup-{full,diff,check}.timer
sudo -n systemctl daemon-reload </dev/null
sudo -n systemctl enable --now pamofi-backup-full.timer pamofi-backup-diff.timer pamofi-backup-check.timer </dev/null
sudo -n systemctl list-timers --all --no-legend 'pamofi-backup-*'
printf 'PamoFi backup timers installed; failures are recorded locally in systemd journal. External alert delivery is not configured.\n'
