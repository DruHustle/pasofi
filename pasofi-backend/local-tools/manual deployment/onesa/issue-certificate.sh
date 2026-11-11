#!/bin/bash
set -euo pipefail
umask 077
root=/home/ubuntu/pamofi/production
host=pamofi.onesa.eu
ip=92.5.170.138
image=pamofi-certbot:5.9.0-arm64
[ "$(docker image inspect "$image" --format '{{.Id}}')" = 'sha256:bc93cb710b413e6b456d622f9b0133b3e109c0a78c2ed9976af43d209b0a1805' ] || { echo 'Unexpected Certbot image.' >&2; exit 1; }
[ ! -e "$root/secrets/public_tls_cert" ] && [ ! -e "$root/secrets/public_tls_key" ] || { echo 'Public TLS files already exist; refusing overwrite.' >&2; exit 1; }
getent ahostsv4 "$host" | awk '{print $1}' | sort -u | grep -qx "$ip" || { echo 'DNS is not pointing to the expected host.' >&2; exit 1; }
[ "$(getent ahostsv4 "$host" | awk '{print $1}' | sort -u | wc -l)" -eq 1 ] || { echo 'Unexpected additional IPv4 DNS records.' >&2; exit 1; }
[ -z "$(ss -H -ltn 'sport = :80')" ] || { echo 'Port 80 is already in use; refusing.' >&2; exit 1; }
iptables -C ONESA_WORKER_INPUT -i enp0s6 -p tcp --dport 80 -j ACCEPT >/dev/null 2>&1 && { echo 'Existing matching port 80 rule; refusing to alter it.' >&2; exit 1; }
mkdir -p "$root/acme/config" "$root/acme/log" "$root/acme/work"
chmod 700 "$root/acme" "$root/acme/config" "$root/acme/log" "$root/acme/work"
opened=false
cleanup() { result=$?; trap - EXIT; if [ "$opened" = true ]; then iptables -D ONESA_WORKER_INPUT -i enp0s6 -p tcp --dport 80 -j ACCEPT || true; fi; exit "$result"; }
trap cleanup EXIT
iptables -I ONESA_WORKER_INPUT 1 -i enp0s6 -p tcp --dport 80 -j ACCEPT
opened=true
docker run --label eu.onesa.product=pasofi --rm --network host --memory 256m --pids-limit 100 --mount "type=bind,source=$root/acme/config,target=/etc/letsencrypt" --mount "type=bind,source=$root/acme/log,target=/var/log/letsencrypt" --mount "type=bind,source=$root/acme/work,target=/var/lib/letsencrypt" "$image" certonly --standalone --non-interactive --agree-tos --no-eff-email --email andrewgotora@yahoo.com --preferred-challenges http -d "$host"
cert="$root/acme/config/live/$host/fullchain.pem"
key="$root/acme/config/live/$host/privkey.pem"
[ -s "$cert" ] && [ -s "$key" ]
openssl x509 -in "$cert" -noout -checkhost "$host" -checkend 86400 >/dev/null
certpub=$(openssl x509 -in "$cert" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | awk '{print $1}')
keypub=$(openssl pkey -in "$key" -pubout -outform DER | sha256sum | awk '{print $1}')
[ "$certpub" = "$keypub" ] || { echo 'Certificate and key do not match.' >&2; exit 1; }
install -o ubuntu -g ubuntu -m 0444 "$cert" "$root/secrets/public_tls_cert"
install -o ubuntu -g ubuntu -m 0444 "$key" "$root/secrets/public_tls_key"
printf 'Issued and installed the PamoFi public certificate; temporary HTTP firewall rule will be removed.\n'
