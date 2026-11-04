#!/bin/sh
set -eu
site_link_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
site_link_tmp=$(mktemp -d "${TMPDIR:-/tmp}/pamofi-nft-check.XXXXXXXX")
trap 'rm -rf -- "$site_link_tmp"' EXIT HUP INT TERM
node --input-type=module - "$site_link_dir" "$site_link_tmp" <<'NODE'
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {buildPlan}=await import(pathToFileURL(`${process.argv[2]}/plan.mjs`));
const files=buildPlan({serverEndpoint:'1.1.1.1',port:51821,serverPublicKey:Buffer.alloc(32,1).toString('base64'),routerPublicKey:Buffer.alloc(32,2).toString('base64'),serverTunnelIp:'10.77.254.1',routerTunnelIp:'10.77.254.2',serverInterface:'pfi-check',routerNetworks:['192.168.88.0/24'],serverNetworks:['172.20.0.0/16']});
await writeFile(`${process.argv[3]}/rules.nft`,files['oracle-firewall.nft.review'],{mode:0o600});
NODE
command -v nft >/dev/null
command -v unshare >/dev/null
# Even the parser's kernel validation occurs only in a disposable network
# namespace. This command never modifies or flushes the host firewall.
if [ "$(id -u)" = 0 ]; then
  unshare --net -- nft --check --file "$site_link_tmp/rules.nft"
else
  sudo -n unshare --net -- nft --check --file "$site_link_tmp/rules.nft"
fi
echo 'Site-link nftables syntax passed in an isolated network namespace.'
