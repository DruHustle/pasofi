#!/bin/sh
set -eu
owner_network_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
owner_network_tmp=$(mktemp -d "${TMPDIR:-/tmp}/pasofi-owner-nft.XXXXXXXX")
trap 'rm -rf -- "$owner_network_tmp"' EXIT HUP INT TERM
node --input-type=module - "$owner_network_dir" "$owner_network_tmp" <<'NODE'
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const directory=process.argv[2];
const {buildPlan}=await import(pathToFileURL(`${directory}/plan.mjs`));
const {fixture}=await import(pathToFileURL(`${directory}/fixture.mjs`));
await writeFile(`${process.argv[3]}/rules.nft`,buildPlan(fixture())['hub-firewall.nft.review'],{mode:0o600,flag:'wx'});
NODE
command -v nft >/dev/null
command -v unshare >/dev/null
# nft's kernel validation occurs only in this disposable network namespace.
# This cannot modify the host firewall; --check does not apply the batch either.
if [ "$(id -u)" = 0 ]; then
  unshare --net -- nft --check --file "$owner_network_tmp/rules.nft"
else
  sudo -n unshare --net -- nft --check --file "$owner_network_tmp/rules.nft"
fi
echo 'Owner-management nftables syntax passed in an isolated network namespace.'
