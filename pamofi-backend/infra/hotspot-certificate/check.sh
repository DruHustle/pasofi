#!/bin/sh
set -eu

# This checks the host copy only. A deployed router certificate must be
# checked independently, and renewed material must be installed there.
cert=${1:-/home/ubuntu/pamofi/production/acme/config/live/pamofi-hotspot-onesaeu/fullchain.pem}
[ "$#" -le 1 ] && [ -r "$cert" ] || { echo 'Hotspot certificate unavailable' >&2; exit 1; }
openssl x509 -in "$cert" -noout -checkhost hotspot.pamofi.onesa.eu | grep -q 'does match' || { echo 'Hotspot certificate hostname mismatch' >&2; exit 1; }
openssl x509 -in "$cert" -noout -checkend 2592000 >/dev/null || { echo 'Hotspot certificate expires within 30 days' >&2; exit 1; }
echo 'Hotspot certificate host copy has the expected hostname and more than 30 days remaining.'
