#!/bin/bash
# Re-sign a router's saved login CSR (key stays on the router). Usage: pasofi-router-login-sign g0|k0
set -euo pipefail
umask 022
site=${1:-}; case "$site" in g0|k0) ;; *) echo 'Usage: pasofi-router-login-sign g0|k0' >&2; exit 2;; esac
root=/home/ubuntu/pamofi/production; d=$root/acme/router-login/$site; image=pamofi-certbot:5.9.0-arm64
[ -r "$d/$site.csr" ] || { echo "Missing $d/$site.csr" >&2; exit 1; }
[ -z "$(ss -H -ltn 'sport = :80')" ] || { echo 'Port 80 is in use.' >&2; exit 1; }
opened=false
cleanup() { r=$?; trap - EXIT; if [ "$opened" = true ]; then iptables -D ONESA_WORKER_INPUT -i enp0s6 -p tcp --dport 80 -m comment --comment pamofi-acme-temporary -j ACCEPT || true; fi; exit $r; }
trap cleanup EXIT
iptables -I ONESA_WORKER_INPUT 1 -i enp0s6 -p tcp --dport 80 -m comment --comment pamofi-acme-temporary -j ACCEPT; opened=true
stamp=$(date +%Y%m%dT%H%M%S); mkdir -p "$d/$stamp"
docker run --rm --network host --memory 256m --pids-limit 100 \
  --mount "type=bind,source=$root/acme/config,target=/etc/letsencrypt" --mount "type=bind,source=$root/acme/log,target=/var/log/letsencrypt" \
  --mount "type=bind,source=$root/acme/work,target=/var/lib/letsencrypt" --mount "type=bind,source=$d,target=/out" \
  "$image" certonly --standalone --non-interactive --csr "/out/$site.csr" \
  --cert-path "/out/$stamp/$site.crt" --chain-path "/out/$stamp/$site.chain.pem" --fullchain-path "/out/$stamp/$site.fullchain.pem"
openssl verify -untrusted "$d/$stamp/$site.chain.pem" "$d/$stamp/$site.crt" >/dev/null
cp "$d/$stamp/$site.crt" "$d/$site.crt"; cp "$d/$stamp/$site.chain.pem" "$d/$site.chain.pem"; cp "$d/$stamp/$site.fullchain.pem" "$d/$site.fullchain.pem"
echo "Signed. Import $d/$site.fullchain.pem on the router (certificate only; the key is already there)."
