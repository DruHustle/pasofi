#!/usr/bin/env bash
# Install or remove the dedicated PamoFi site-01 guards without replacing the
# shared host's firewall. Run as root only after reviewing the named nft batch.
set -euo pipefail

readonly nft_file=${PAMOFI_SITE01_NFT_FILE:-/etc/pamofi/site01/guard.nft}
readonly interface=pfi-site01
readonly table=pfi_site01
readonly chain=ONESA_WORKER_INPUT
readonly comment=pamofi-site01-wireguard
readonly wan=enp0s6
readonly port=51821
readonly nft_sha256=cc412f0bc0775491aa377afaf864829c7a93d9cdb3c1c55e5db7bc1f030b9a43

if [[ $EUID -ne 0 || $# -ne 1 || ( $1 != start && $1 != stop ) ]]; then
  echo 'Run as root with exactly one argument: start or stop.' >&2
  exit 2
fi

exec 9>/run/lock/pamofi-site01-firewall.lock
flock -x 9

rule=(-i "$wan" -p udp --dport "$port" -m comment --comment "$comment" -j ACCEPT)

if [[ $1 == start ]]; then
  [[ -f "$nft_file" && ! -L "$nft_file" ]] || { echo 'Reviewed nft batch is missing or is a symlink.' >&2; exit 1; }
  file_owner=$(stat -c '%u' "$nft_file")
  file_mode=$(stat -c '%a' "$nft_file")
  if [[ $file_owner != 0 || ! $file_mode =~ ^[0-7]{3,4}$ ]] || (( (8#$file_mode & 8#022) != 0 )); then
    echo 'Reviewed nft batch must be root-owned and not group/other writable.' >&2
    exit 1
  fi
  actual_sha256=$(sha256sum "$nft_file")
  if [[ ${actual_sha256%% *} != "$nft_sha256" ]]; then
    echo 'Reviewed nft batch digest does not match the site-01 plan.' >&2
    exit 1
  fi
  if ip link show dev "$interface" >/dev/null 2>&1; then
    echo 'An existing site interface requires inspection before starting the guard.' >&2
    exit 1
  fi
  iptables -S "$chain" >/dev/null
  if nft list table inet "$table" >/dev/null 2>&1 || iptables -C "$chain" "${rule[@]}" 2>/dev/null; then
    echo 'Existing site guard requires inspection before starting.' >&2
    exit 1
  fi
  nft -c -f "$nft_file"
  nft -f "$nft_file"
  # If installing the port rule fails, undo only the table created above.
  if ! iptables -I "$chain" 1 "${rule[@]}"; then
    nft delete table inet "$table"
    echo 'Could not add the site transport rule; the new guard was removed.' >&2
    exit 1
  fi
  echo 'PamoFi site-01 guard installed.'
else
  if ip link show dev "$interface" >/dev/null 2>&1; then
    echo 'Stop the PamoFi WireGuard interface before removing its guard.' >&2
    exit 1
  fi
  # Close transport first. Never remove a rule that does not match exactly.
  if iptables -C "$chain" "${rule[@]}" 2>/dev/null; then
    iptables -D "$chain" "${rule[@]}"
  fi
  if nft list table inet "$table" >/dev/null 2>&1; then
    nft delete table inet "$table"
  fi
  echo 'PamoFi site-01 guard removed.'
fi
