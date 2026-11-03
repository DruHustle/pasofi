#!/usr/bin/env bash
# The kernel firewall test runs only in a fresh network namespace.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo 'Run this isolated test as root (for example, sudo bash test-site01-firewall.sh).' >&2
  exit 2
fi
site_test_dir=$(cd -- "$(dirname -- "$0")" && pwd)
site_test_tmp=$(mktemp -d "${TMPDIR:-/tmp}/pamofi-site01-guard-test.XXXXXXXX")
trap 'rm -rf -- "$site_test_tmp"' EXIT

if [[ -n ${PAMOFI_SITE01_TEST_NFT_FILE:-} ]]; then
  cp -- "$PAMOFI_SITE01_TEST_NFT_FILE" "$site_test_tmp/guard.nft"
  chmod 600 "$site_test_tmp/guard.nft"
else
  node --input-type=module - "$site_test_dir" "$site_test_tmp" <<'NODE'
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {buildPlan} = await import(pathToFileURL(`${process.argv[2]}/plan.mjs`));
const files = buildPlan({serverEndpoint:'1.1.1.1',port:51821,
  serverPublicKey:Buffer.alloc(32,1).toString('base64'),
  routerPublicKey:Buffer.alloc(32,2).toString('base64'),
  serverTunnelIp:'10.77.254.1',routerTunnelIp:'10.77.254.2',serverInterface:'pfi-site01',
  routerNetworks:['192.168.88.0/24'],serverNetworks:['172.20.0.0/16']});
await writeFile(`${process.argv[3]}/guard.nft`,files['oracle-firewall.nft.review'],{mode:0o600});
NODE
fi
cp "$site_test_tmp/guard.nft" "$site_test_tmp/altered.nft"
printf '\n# unexpected change\n' >> "$site_test_tmp/altered.nft"
cp "$site_test_tmp/guard.nft" "$site_test_tmp/writable.nft"
chmod 666 "$site_test_tmp/writable.nft"
ln -s "$site_test_tmp/guard.nft" "$site_test_tmp/symlink.nft"

unshare --net -- bash -s -- "$site_test_dir/site01-firewall.sh" "$site_test_tmp" <<'TEST'
set -euo pipefail
guard_script=$1
test_dir=$2
iptables -N ONESA_WORKER_INPUT
iptables -A INPUT -j ONESA_WORKER_INPUT
iptables -A ONESA_WORKER_INPUT -j DROP
export PAMOFI_SITE01_NFT_FILE="$test_dir/guard.nft"

for invalid in "$test_dir/altered.nft" "$test_dir/writable.nft" "$test_dir/symlink.nft"; do
  if PAMOFI_SITE01_NFT_FILE="$invalid" bash "$guard_script" start >/dev/null 2>&1; then
    echo 'Guard unexpectedly accepted an altered or symlinked batch.' >&2; exit 1
  fi
done
if nft list table inet pfi_site01 >/dev/null 2>&1; then echo 'Refused batch changed firewall state.' >&2; exit 1; fi

nft add table inet pfi_site01
if bash "$guard_script" start >/dev/null 2>&1; then echo 'Guard adopted an existing table.' >&2; exit 1; fi
nft list table inet pfi_site01 >/dev/null
nft delete table inet pfi_site01
iptables -I ONESA_WORKER_INPUT 1 -i enp0s6 -p udp --dport 51821 -m comment --comment pamofi-site01-wireguard -j ACCEPT
if bash "$guard_script" start >/dev/null 2>&1; then echo 'Guard adopted an existing transport rule.' >&2; exit 1; fi
iptables -C ONESA_WORKER_INPUT -i enp0s6 -p udp --dport 51821 -m comment --comment pamofi-site01-wireguard -j ACCEPT
iptables -D ONESA_WORKER_INPUT -i enp0s6 -p udp --dport 51821 -m comment --comment pamofi-site01-wireguard -j ACCEPT

ip link add pfi-site01 type dummy
if bash "$guard_script" start >/dev/null 2>&1; then echo 'Guard accepted an existing interface.' >&2; exit 1; fi
ip link delete pfi-site01
bash "$guard_script" start
nft list table inet pfi_site01 >/dev/null
iptables -C ONESA_WORKER_INPUT -i enp0s6 -p udp --dport 51821 -m comment --comment pamofi-site01-wireguard -j ACCEPT
if bash "$guard_script" start >/dev/null 2>&1; then echo 'Guard accepted a duplicate start.' >&2; exit 1; fi
iptables -D ONESA_WORKER_INPUT -i enp0s6 -p udp --dport 51821 -m comment --comment pamofi-site01-wireguard -j ACCEPT
if bash "$guard_script" stop >/dev/null 2>&1; then
  echo 'Guard accepted an unexpected missing transport rule.' >&2; exit 1
fi
nft list table inet pfi_site01 >/dev/null
iptables -I ONESA_WORKER_INPUT 1 -i enp0s6 -p udp --dport 51821 -m comment --comment pamofi-site01-wireguard -j ACCEPT
mkdir "$test_dir/failing-ip"
printf '#!/bin/sh\nexit 1\n' > "$test_dir/failing-ip/ip"
chmod 700 "$test_dir/failing-ip/ip"
if PATH="$test_dir/failing-ip:$PATH" bash "$guard_script" stop >/dev/null 2>&1; then
  echo 'Guard removed protection after an interface inspection failure.' >&2; exit 1
fi
nft list table inet pfi_site01 >/dev/null
iptables -C ONESA_WORKER_INPUT -i enp0s6 -p udp --dport 51821 -m comment --comment pamofi-site01-wireguard -j ACCEPT
ip link add pfi-site01 type dummy
if bash "$guard_script" stop >/dev/null 2>&1; then echo 'Guard removed protection from an existing interface.' >&2; exit 1; fi
ip link delete pfi-site01
bash "$guard_script" stop
if nft list table inet pfi_site01 >/dev/null 2>&1; then echo 'Guard table remained after removal.' >&2; exit 1; fi
if iptables -C ONESA_WORKER_INPUT -i enp0s6 -p udp --dport 51821 -m comment --comment pamofi-site01-wireguard -j ACCEPT 2>/dev/null; then
  echo 'Guard transport rule remained after removal.' >&2; exit 1
fi
iptables -C ONESA_WORKER_INPUT -j DROP
echo 'Site-01 guard checks passed in an isolated network namespace.'
TEST
