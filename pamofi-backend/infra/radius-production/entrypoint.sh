#!/bin/sh
set -eu
if [ "${PAMOFI_RADIUS_QUALIFIED:-}" != true ]; then
  echo 'Production RADIUS requires explicit qualification.' >&2
  exit 1
fi
bound=$(cat /run/secrets/radius_bind_ip)
case "$bound" in
  ''|*[!0-9.]*) echo 'A single canonical private IPv4 bind is required.' >&2; exit 1 ;;
esac
if [ "$bound" != "${PAMOFI_RADIUS_TUNNEL_IP:-}" ]; then
  echo 'RADIUS host binding does not match the reviewed material.' >&2
  exit 1
fi
# This validates the Compose host bind. FreeRADIUS listens inside its isolated
# container; Docker must publish only this exact private WireGuard address.
printf '%s\n' "$bound" | awk -F. '
 NF != 4 {exit 1}
 {for(i=1;i<=4;i++) if($i !~ /^(0|[1-9][0-9]*)$/ || $i>255) exit 1;
  if(!($1==10 || ($1==172 && $2>=16 && $2<=31) || ($1==192 && $2==168))) exit 1}
' || { echo 'A private IPv4 tunnel bind is required.' >&2; exit 1; }
exec radiusd -f -l stdout
