#!/bin/bash
set -euo pipefail
umask 077
tmp=$(mktemp -d /tmp/pamofi-alert-units.XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT
for p in /usr/local/sbin/pamofi-send-alert /usr/local/sbin/pamofi-health-check /etc/systemd/system/pamofi-alert@.service /etc/systemd/system/pamofi-health.service /etc/systemd/system/pamofi-health.timer; do [ ! -e "$p" ] || { echo "Existing PamoFi alert file; refusing overwrite: $p" >&2; exit 1; }; done
for unit in 'pamofi-backup@.service' pamofi-restore-drill.service pamofi-cert-renew.service; do [ ! -e "/etc/systemd/system/$unit.d/pamofi-alert.conf" ] || { echo "Existing PamoFi alert drop-in; refusing overwrite." >&2; exit 1; }; done
cat > "$tmp/pamofi-send-alert" <<'EOF'
#!/bin/bash
set -euo pipefail
umask 077
unit=${1:-}
[[ "$unit" =~ ^pamofi-[A-Za-z0-9@_.:-]+$ ]] || { echo 'Invalid PamoFi unit name' >&2; exit 2; }
state=/var/lib/pamofi-alerts
install -d -o root -g root -m 0700 "$state"
exec 9>"$state/lock"
flock -w 15 9
stamp="$state/$(printf '%s' "$unit" | sha256sum | cut -d' ' -f1)"
now=$(date +%s)
if [ -f "$stamp" ]; then last=$(cat "$stamp"); [[ "$last" =~ ^[0-9]+$ ]] && [ $((now-last)) -lt 21600 ] && { echo 'PamoFi alert rate-limited for this unit.'; exit 0; }; fi
/usr/bin/docker run --rm --network host --read-only --tmpfs /tmp -e HOME=/tmp ghcr.io/oracle/oci-cli@sha256:daad6a840e60470dabc642ef2d18968bfa773bc8f5d2b0f488d061642f6d03b2 ons message publish --topic-id ocid1.onstopic.oc1.eu-frankfurt-1.amaaaaaadhe5tbaatkeivjjoln3pkph5hbnimgrfbrmb4sedreik6ysm7cpa --title 'PamoFi operational alert' --body "PamoFi service $unit failed on Onesa Backend. Inspect its systemd journal and verify backups and service availability." --auth instance_principal --region eu-frankfurt-1 --query 'data."message-id"' --raw-output >/dev/null
printf '%s\n' "$now" > "$stamp"
echo 'PamoFi operational alert accepted by Oracle Notifications.'
EOF
cat > "$tmp/pamofi-health-check" <<'EOF'
#!/bin/bash
set -euo pipefail
for service in postgres identity prepaid-access network notification assistant web internal-gateway gateway; do
 container="pamofi-production-$service-1"
 state=$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')
 case "$state" in healthy|running) ;; *) echo "PamoFi $service is $state" >&2; exit 1;; esac
done
curl -fsS --max-time 15 https://pamofi.onesa.eu/health/live | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("status")=="ok" and d.get("service")=="gateway"'
curl -fsS --max-time 20 https://pamofi.vercel.app/api/capabilities | python3 -c 'import json,sys; d=json.load(sys.stdin); assert isinstance(d.get("networkAccess"),bool) and isinstance(d.get("staffSales"),bool)'
openssl x509 -in /home/ubuntu/pamofi/production/secrets/public_tls_cert -noout -checkend 1209600 >/dev/null
available=$(df -Pk / | awk 'NR==2 {print $4}')
[ "$available" -ge 2097152 ] || { echo 'PamoFi host has less than 2 GiB free.' >&2; exit 1; }
echo 'PamoFi service, public HTTPS, certificate and disk checks passed.'
EOF
cat > "$tmp/pamofi-alert@.service" <<'EOF'
[Unit]
Description=Send a PamoFi failure alert for %i
After=docker.service network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/pamofi-send-alert %i
TimeoutStartSec=2m
NoNewPrivileges=yes
EOF
cat > "$tmp/pamofi-health.service" <<'EOF'
[Unit]
Description=PamoFi service and public HTTPS health check
After=docker.service network-online.target
Wants=network-online.target
OnFailure=pamofi-alert@%n.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/pamofi-health-check
TimeoutStartSec=2m
NoNewPrivileges=yes
EOF
cat > "$tmp/pamofi-health.timer" <<'EOF'
[Unit]
Description=PamoFi recurring service health check
[Timer]
OnBootSec=5m
OnUnitActiveSec=5m
RandomizedDelaySec=30s
Unit=pamofi-health.service
[Install]
WantedBy=timers.target
EOF
cat > "$tmp/pamofi-alert.conf" <<'EOF'
[Unit]
OnFailure=pamofi-alert@%n.service
EOF
bash -n "$tmp/pamofi-send-alert" "$tmp/pamofi-health-check"
for name in pamofi-send-alert pamofi-health-check; do sudo -n install -o root -g root -m 0755 "$tmp/$name" "/usr/local/sbin/$name"; done
for unit in pamofi-alert@.service pamofi-health.service pamofi-health.timer; do sudo -n install -o root -g root -m 0644 "$tmp/$unit" "/etc/systemd/system/$unit"; done
for unit in 'pamofi-backup@.service' pamofi-restore-drill.service pamofi-cert-renew.service; do sudo -n install -d -o root -g root -m 0755 "/etc/systemd/system/$unit.d"; sudo -n install -o root -g root -m 0644 "$tmp/pamofi-alert.conf" "/etc/systemd/system/$unit.d/pamofi-alert.conf"; done
sudo -n systemd-analyze verify /etc/systemd/system/pamofi-alert@.service /etc/systemd/system/pamofi-health.service /etc/systemd/system/pamofi-health.timer
sudo -n systemctl daemon-reload </dev/null
sudo -n systemctl enable --now pamofi-health.timer </dev/null
sudo -n systemctl start pamofi-health.service </dev/null
sudo -n systemctl show pamofi-health.service --property=Result --property=ExecMainStatus
printf 'PamoFi health and failure alert jobs installed.\n'
