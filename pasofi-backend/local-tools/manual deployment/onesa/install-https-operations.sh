#!/bin/bash
set -euo pipefail
umask 077
tmp=$(mktemp -d /tmp/pamofi-https-units.XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT
for p in /usr/local/sbin/pamofi-https-firewall /usr/local/sbin/pamofi-cert-renew /etc/systemd/system/pamofi-https-firewall.service /etc/systemd/system/pamofi-cert-renew.service /etc/systemd/system/pamofi-cert-renew.timer; do [ ! -e "$p" ] || { echo "Existing PamoFi HTTPS file; refusing overwrite: $p" >&2; exit 1; }; done
cat > "$tmp/pamofi-https-firewall" <<'EOF'
#!/bin/bash
set -euo pipefail
rule=(-i enp0s6 -d 10.245.242.10/32 -p tcp --dport 443 -m comment --comment pamofi-https-gateway -j ACCEPT)
case "${1:-}" in
 start) iptables -C DOCKER-USER "${rule[@]}" 2>/dev/null || iptables -I DOCKER-USER 1 "${rule[@]}";;
 stop) if iptables -C DOCKER-USER "${rule[@]}" 2>/dev/null; then iptables -D DOCKER-USER "${rule[@]}"; fi;;
 *) echo 'Expected start or stop' >&2; exit 2;;
esac
EOF
cat > "$tmp/pamofi-cert-renew" <<'EOF'
#!/bin/bash
set -euo pipefail
umask 077
root=/home/ubuntu/pamofi/production
hosts=(api.pasofi.onesa.eu hotspot.pasofi.mobile.onesa.eu)
cert_name=pamofi-api-onesaeu
image=pamofi-certbot:5.9.0-arm64
dry=false
case "${1:-}" in '') ;; --dry-run) dry=true;; *) echo 'Invalid renewal option' >&2; exit 2;; esac
[ "$(docker image inspect "$image" --format '{{.Id}}')" = 'sha256:bc93cb710b413e6b456d622f9b0133b3e109c0a78c2ed9976af43d209b0a1805' ] || { echo 'Unexpected Certbot image.' >&2; exit 1; }
[ -z "$(ss -H -ltn 'sport = :80')" ] || { echo 'Port 80 is in use; renewal refused.' >&2; exit 1; }
iptables -C ONESA_WORKER_INPUT -i enp0s6 -p tcp --dport 80 -m comment --comment pamofi-acme-temporary -j ACCEPT >/dev/null 2>&1 && { echo 'Unexpected pre-existing PamoFi validation rule.' >&2; exit 1; }
opened=false
cleanup() { result=$?; trap - EXIT; if [ "$opened" = true ]; then iptables -D ONESA_WORKER_INPUT -i enp0s6 -p tcp --dport 80 -m comment --comment pamofi-acme-temporary -j ACCEPT || true; fi; exit "$result"; }
trap cleanup EXIT
iptables -I ONESA_WORKER_INPUT 1 -i enp0s6 -p tcp --dport 80 -m comment --comment pamofi-acme-temporary -j ACCEPT
opened=true
args=(renew --quiet --non-interactive --no-random-sleep-on-renew --cert-name "$cert_name")
[ "$dry" = false ] || args+=(--dry-run)
docker run --label eu.onesa.product=pasofi --rm --network host --memory 256m --pids-limit 100 --mount "type=bind,source=$root/acme/config,target=/etc/letsencrypt" --mount "type=bind,source=$root/acme/log,target=/var/log/letsencrypt" --mount "type=bind,source=$root/acme/work,target=/var/lib/letsencrypt" "$image" "${args[@]}"
if [ "$dry" = true ]; then echo 'Certificate renewal dry run passed.'; exit 0; fi
cert="$root/acme/config/live/$cert_name/fullchain.pem"
key="$root/acme/config/live/$cert_name/privkey.pem"
for host in "${hosts[@]}"; do openssl x509 -in "$cert" -noout -checkhost "$host" -checkend 1814400 >/dev/null; done
certpub=$(openssl x509 -in "$cert" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | awk '{print $1}')
keypub=$(openssl pkey -in "$key" -pubout -outform DER | sha256sum | awk '{print $1}')
[ "$certpub" = "$keypub" ] || { echo 'Renewed certificate and key do not match.' >&2; exit 1; }
if ! cmp -s "$cert" "$root/secrets/public_tls_cert" || ! cmp -s "$key" "$root/secrets/public_tls_key"; then
 install -o ubuntu -g ubuntu -m 0444 "$cert" "$root/secrets/public_tls_cert.next"
 install -o ubuntu -g ubuntu -m 0444 "$key" "$root/secrets/public_tls_key.next"
 mv -f "$root/secrets/public_tls_cert.next" "$root/secrets/public_tls_cert"
 mv -f "$root/secrets/public_tls_key.next" "$root/secrets/public_tls_key"
 mapfile -t gateways < <(docker ps --filter label=com.docker.compose.project=pamofi-production --filter label=com.docker.compose.service=gateway --format '{{.ID}}')
 [ "${#gateways[@]}" -eq 1 ] || { echo 'Expected exactly one running PasoFi gateway; refusing recreation.' >&2; exit 1; }
 gateway=${gateways[0]}
 label() { docker inspect --format "{{ index .Config.Labels \"com.docker.compose.$1\" }}" "$gateway"; }
 project=$(label project)
 workdir=$(label project.working_dir)
 config_list=$(label project.config_files)
 env_list=$(label project.environment_file)
 [ "$project" = pamofi-production ] && [ -n "$workdir" ] && [ -n "$config_list" ] && [ -n "$env_list" ] || { echo 'The gateway Compose provenance is incomplete; refusing recreation.' >&2; exit 1; }
 case "$workdir" in /var/lib/onesa/pasofi-release-*|/home/ubuntu/pamofi/releases/*|/home/ubuntu/pamofi/production) ;; *) echo 'Unexpected gateway Compose working directory; refusing recreation.' >&2; exit 1;; esac
 [ -d "$workdir" ] && [ ! -L "$workdir" ] || { echo 'Gateway Compose working directory is unavailable or linked.' >&2; exit 1; }
 lockfile="$workdir/.pasofi-release-$project.lock"
 if [ ! -e "$lockfile" ]; then install -o ubuntu -g ubuntu -m 0600 /dev/null "$lockfile"; fi
 [ -f "$lockfile" ] && [ ! -L "$lockfile" ] || { echo 'Gateway deployment lock is unavailable or linked.' >&2; exit 1; }
 exec 9<>"$lockfile"
 flock -n 9 || { echo 'A PasoFi release is in progress; certificate sync will retry next time.' >&2; exit 1; }
 IFS=, read -r -a compose_files <<< "$config_list"
 IFS=, read -r -a env_files <<< "$env_list"
 compose=(docker compose --project-name "$project" --project-directory "$workdir" --profile '*')
 for path in "${env_files[@]}"; do
   case "$path" in /dev/null|/var/lib/onesa/pasofi-release-*|/home/ubuntu/pamofi/releases/*|/home/ubuntu/pamofi/production/*) ;; *) echo 'Unexpected gateway Compose environment path; refusing recreation.' >&2; exit 1;; esac
   [ -f "$path" ] && [ ! -L "$path" ] || { echo 'Gateway Compose environment file is unavailable or linked.' >&2; exit 1; }
   compose+=(--env-file "$path")
 done
 for path in "${compose_files[@]}"; do
   case "$path" in /var/lib/onesa/pasofi-release-*|/home/ubuntu/pamofi/releases/*|/home/ubuntu/pamofi/production/*) ;; *) echo 'Unexpected gateway Compose file path; refusing recreation.' >&2; exit 1;; esac
   [ -f "$path" ] && [ ! -L "$path" ] || { echo 'Gateway Compose file is unavailable or linked.' >&2; exit 1; }
   compose+=(-f "$path")
 done
 expected_hash=$(label config-hash)
 actual_hash=$("${compose[@]}" config --hash gateway | awk '$1 == "gateway" { print $2 }')
 [ -n "$expected_hash" ] && [ "$actual_hash" = "$expected_hash" ] || { echo 'Current gateway Compose configuration differs from the running container; refusing recreation.' >&2; exit 1; }
 "${compose[@]}" up -d --no-deps --force-recreate --wait --wait-timeout 120 gateway
fi
echo 'PamoFi certificate is valid and up to date.'
EOF
cat > "$tmp/pamofi-https-firewall.service" <<'EOF'
[Unit]
Description=pasofi HTTPS gateway firewall rule
Requires=docker.service
After=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/pamofi-https-firewall start
ExecStop=/usr/local/sbin/pamofi-https-firewall stop
[Install]
WantedBy=multi-user.target
EOF
cat > "$tmp/pamofi-cert-renew.service" <<'EOF'
[Unit]
Description=pasofi public certificate renewal
After=docker.service network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/pamofi-cert-renew
TimeoutStartSec=20m
NoNewPrivileges=yes
EOF
cat > "$tmp/pamofi-cert-renew.timer" <<'EOF'
[Unit]
Description=pasofi daily public certificate renewal check
[Timer]
OnCalendar=*-*-* 04:10:00 UTC
RandomizedDelaySec=30m
Persistent=true
Unit=pamofi-cert-renew.service
[Install]
WantedBy=timers.target
EOF
bash -n "$tmp/pamofi-https-firewall" "$tmp/pamofi-cert-renew"
for name in pamofi-https-firewall pamofi-cert-renew; do sudo -n install -o root -g root -m 0755 "$tmp/$name" "/usr/local/sbin/$name"; done
for unit in pamofi-https-firewall.service pamofi-cert-renew.service pamofi-cert-renew.timer; do sudo -n install -o root -g root -m 0644 "$tmp/$unit" "/etc/systemd/system/$unit"; done
sudo -n systemd-analyze verify /etc/systemd/system/pamofi-https-firewall.service /etc/systemd/system/pamofi-cert-renew.service /etc/systemd/system/pamofi-cert-renew.timer
sudo -n systemctl daemon-reload </dev/null
sudo -n systemctl enable --now pamofi-https-firewall.service pamofi-cert-renew.timer </dev/null
printf 'PamoFi HTTPS firewall and certificate renewal schedule installed.\n'
