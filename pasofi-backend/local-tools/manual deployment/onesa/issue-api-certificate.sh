#!/bin/bash
set -euo pipefail
umask 077
root=/home/ubuntu/pamofi/production
image=pamofi-certbot:5.9.0-arm64
for hostname in api.pamofi.onesa.eu; do
 [ "$(getent ahostsv4 "$hostname" | awk '{print $1}' | sort -u)" = 92.5.170.138 ] || { echo "Unexpected DNS for $hostname" >&2; exit 1; }
done
[ "$(systemctl is-active pamofi-cert-renew.service || true)" = inactive ] || { echo 'Certificate renewal is already running.' >&2; exit 1; }
[ -z "$(ss -H -ltn 'sport = :80')" ] || { echo 'Port 80 is occupied.' >&2; exit 1; }
iptables -C ONESA_WORKER_INPUT -i enp0s6 -p tcp --dport 80 -m comment --comment pamofi-acme-temporary -j ACCEPT >/dev/null 2>&1 && { echo 'Validation firewall rule already exists.' >&2; exit 1; }
opened=false
cleanup() { result=$?; trap - EXIT; if [ "$opened" = true ]; then iptables -D ONESA_WORKER_INPUT -i enp0s6 -p tcp --dport 80 -m comment --comment pamofi-acme-temporary -j ACCEPT || true; fi; exit "$result"; }
trap cleanup EXIT
iptables -I ONESA_WORKER_INPUT 1 -i enp0s6 -p tcp --dport 80 -m comment --comment pamofi-acme-temporary -j ACCEPT
opened=true
docker run --label eu.onesa.product=pasofi --rm --network host --memory 256m --pids-limit 100 --mount "type=bind,source=$root/acme/config,target=/etc/letsencrypt" --mount "type=bind,source=$root/acme/log,target=/var/log/letsencrypt" --mount "type=bind,source=$root/acme/work,target=/var/lib/letsencrypt" "$image" certonly --standalone --non-interactive --agree-tos --no-eff-email --email andrewgotora@yahoo.com --preferred-challenges http --cert-name pamofi-api-onesaeu -d api.pamofi.onesa.eu
cert="$root/acme/config/live/pamofi-api-onesaeu/fullchain.pem"
key="$root/acme/config/live/pamofi-api-onesaeu/privkey.pem"
openssl x509 -in "$cert" -noout -checkhost api.pamofi.onesa.eu -checkend 86400 >/dev/null
certpub=$(openssl x509 -in "$cert" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | awk '{print $1}')
keypub=$(openssl pkey -in "$key" -pubout -outform DER | sha256sum | awk '{print $1}')
[ "$certpub" = "$keypub" ] || { echo 'Certificate key mismatch.' >&2; exit 1; }
echo 'The API-only certificate is ready; the active gateway certificate remains unchanged.'
