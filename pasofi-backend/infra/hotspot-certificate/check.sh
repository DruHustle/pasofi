#!/bin/sh
set -eu

# Checks the Oracle host copies of the router-local HotSpot login certificates
# (login.pasofi.mobile.onesa.eu). Each router keeps its own private key; this does
# not check what a router serves. Renew with router-login-sign.sh, then import the
# new chain on that router. Pass one certificate path to check only that file.
host=login.pasofi.mobile.onesa.eu
base=/home/ubuntu/pamofi/production/acme/router-login
[ "$#" -le 1 ] || { echo 'Usage: check.sh [certificate]' >&2; exit 2; }
if [ "$#" -eq 1 ]; then certs=$1; else certs="$base/g0/g0.crt $base/k0/k0.crt"; fi
for cert in $certs; do
  [ -r "$cert" ] || { echo "Hotspot certificate unavailable: $cert" >&2; exit 1; }
  openssl x509 -in "$cert" -noout -checkhost "$host" | grep -q 'does match' || { echo "Hotspot certificate hostname mismatch: $cert" >&2; exit 1; }
  openssl x509 -in "$cert" -noout -checkend 2592000 >/dev/null || { echo "Hotspot certificate expires within 30 days: $cert" >&2; exit 1; }
done
echo 'Router login certificate host copies have the expected hostname and more than 30 days remaining.'
