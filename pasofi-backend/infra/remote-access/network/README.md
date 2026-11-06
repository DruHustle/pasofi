# Owner access to multiple gateways and management devices

This offline planner prepares a separate owner-management network. An existing
Tailscale owner identity reaches a selected Linux hub; each inspected MikroTik
initiates a dedicated WireGuard connection to that hub. The hub routes only the
listed device management `/32` addresses. Tenda, Mercusys and other devices use
their native administration interfaces through an inspected local gateway.

**Every output is `prepared-only`.** The tool does not contact devices, discover
addresses, create keys, install software, alter routes/firewalls, authenticate an
owner, or establish live remote access. There are no site keys, allocations or
inventories in this directory. `fixture.mjs` is synthetic test data only.

The earlier single-router planner remains unchanged. The RADIUS/backend service
tunnel remains a separate authority with its existing restrictions. This planner
does not reuse its key, interface or peer, and does not add firmware/reboot actions
to the central fleet application. A VPN login supplies a network path; native
device accounts still authenticate each management session.

## Prepare an inspected plan

Copy `plan.template.json` to an operator-controlled location outside Git. Replace
every placeholder with observed facts. The template deliberately fails validation.
Run with a new absolute output directory whose existing parent is private:

```sh
node pasofi-backend/infra/remote-access/network/plan.mjs \
  /private/owner-network-plan.json /private/new-owner-network-review
```

The output directory is `0700` and every file is `0600`; existing paths are never
overwritten. Output inside any Git worktree is refused, including a parent path
that resolves into one through a symlink. Treat inputs and outputs as private
network inventory even though they contain no credentials or private keys.

| Input | Required evidence |
| --- | --- |
| `owner.tailscaleLogin` | The exact existing Tailscale login. Email-style identities and the literal `@github` / `@passkey` forms are accepted without normalization. |
| `owner.ipv4Routes` | Complete observed non-default IPv4 routes on the actual remote client, including other VPNs. An explicitly inspected empty array is supported; an omitted inventory is rejected. |
| Hub | Selected reachable public IPv4/DNS endpoint, unused UDP port, fresh `pfi-owner` Linux interface name (at most 15 characters), locally derived public key, unallocated private `/32`, observed Tailscale **StableNodeID**, complete non-default IPv4 routes, and the full current IPv4/IPv6 advertised-route list. |
| Each gateway | Stable ID/name, observed hardware serial and UTC observation time, fresh disabled `pfi-owner` interface/key/listen port, unique private `/32`, exact WAN interface, complete non-default IPv4 route inventory, and explicitly selected management permissions. |
| Each downstream device | Unique ID/address and observed physical serial or management MAC, vendor category, observation time, explicit permissions, actual connected management interface/prefix and its inspected gateway LAN address. |
| Return path | `source-nat` for exact per-target LAN-source translation, or `verified-gateway-route` only after independently observing a suitable return route through the selected gateway. |

Gateway and target `management` objects require a unique, nonempty `tcpPorts`
subset of **22, 80, 443, 8291** and an explicit `icmp` boolean. TCP22 is native
device SSH, not Tailscale SSH; it is included only when deliberately selected for
an inspected enabled service. `icmp` permits echo diagnostics. Conntrack-related
ICMP errors needed by already allowed flows remain narrowly permitted.

All new routes are unique private IPv4 `/32`s. Allocation overlaps, conflicting
client/hub destinations, ambiguous management-LAN ownership, duplicate physical
identities, public/default targets, missing inventories, malformed keys and
unknown/private-key fields are rejected. A gateway can own up to 32 downstream
devices; at most 16 gateways and 128 total devices are accepted. Shared upstream
transit networks in gateway inventories are allowed; they are not advertised.
An additional **80 actual mutation** limit applies to each complete gateway
apply and rollback. This stays below RouterOS's 100-action Safe Mode history
ceiling; enabling optional echo/source NAT increases the action count and can
reduce the usable target count. The planner refuses an oversized change and
records exact counts. It does not silently split or omit targets.

The return path must be a directly connected, inspected management LAN with a
usable gateway address. WAN/service interfaces and more-specific routes that
override the claimed local path are rejected. This first version requires main
table routing: active RouterOS routing rules or routing marks fail preflight.
Different routing domains, overlapping site addresses, address translation for
duplicate destinations, remote private endpoints, default advertisements and
IPv6-only site targets require a separately reviewed design.

## Review files

| Output | Purpose |
| --- | --- |
| `router-<id>.rsc.review` | Serial/key/listener/service/LAN/route preflight, interface-scoped guards, optional target source NAT, one hub peer, exact hub route and final interface enablement. |
| `router-<id>.rollback.rsc.review` | Checked removal of the exact owned records after disabling this management interface. Requires independent local recovery and a complete inspected apply. |
| `hub-wireguard.conf.review` | One fresh hub interface and multiple peers with disjoint router/target `/32` ownership. The hub private-key placeholder is replaced only on the hub. |
| `hub-firewall.nft.review` | A new interface-scoped guard table for integration with the actual host firewall. It neither opens the public listener nor replaces existing policy. |
| `tailscale-policy-fragment.json` | Target-specific owner grants and TCP policy tests. Merge with the existing tailnet policy, never replace it blindly. |
| `tailscale-route-command.txt.review` | Full union of the explicitly inventoried prior IPv4/IPv6 advertisements and the new device `/32`s. |
| `owner-targets.json` | Stable private [Mac checker contract](MANIFEST.md), containing only owner/hub identity and expected target information. |
| `review.json` | Source digest, preserved route snapshot, integration requirements and physical acceptance gates, all pending. |

## Traffic and source translation

At the hub, forwarding filters see the owner's Tailscale IPv4 address **before**
Tailscale subnet SNAT. Default subnet SNAT then makes RouterOS see the hub's
WireGuard `/32`. The generated postrouting guard rejects packets leaving this
interface with another source. Userspace-networking mode, disabled subnet SNAT,
unexpected NAT or policy routing is outside this contract and must be resolved
before activation.

The gateway admits only that hub source, its own management address or an exact
listed downstream address, the selected TCP ports/echo, and the inspected egress
interface. Optional source NAT translates only that target/port tuple to its
inspected LAN gateway address. Replies pass after reverse NAT has restored the
hub destination. Reply rules require the target source, selected TCP source
port, expected interfaces and established state; unsolicited return traffic is
denied. Related ICMP errors retain conntrack checks. The hub sees the restored
owner destination before return forwarding.

All owner-interface allowlists and blanket drops precede existing RouterOS
accepts/FastTrack. Spoofed hub-source traffic from another interface is rejected.
Inner IPv6 and other forwarding are denied. No new customer subnet/default route,
LAN membership, RADIUS permission, public management listener or existing
service-account change is generated. Native service address restrictions and
device-specific LAN/WAN administration rules still apply; source NAT alone does
not prove that a vendor UI works.

## Integrate and qualify

1. Re-inspect addresses, identities, enabled services and routes; retain an
   off-device backup and independent local recovery. Prepare only a fresh
   disabled dedicated gateway interface. Keep all private keys on their
   originating devices. The hub owner-plane key must differ from service keys.
2. Review the host's existing firewall manager, raw/NAT/flow-offload rules,
   policy routing, interface/listener ownership, IPv4 forwarding and cloud UDP
   policy. Validate the nft batch in an isolated namespace first. Install
   interface guards before starting the new tunnel; use the existing host
   firewall to admit only its selected outer UDP port. An `accept` in the new
   nft table cannot override another chain's later drop. Preserve SSH recovery.
3. Transfer each exact RouterOS review to an ordinary `.rsc` file, never an
   `.auto.rsc` filename. On RouterOS 7.25, run
   `import file-name=<file>.rsc verbose=yes dry-run` before an apply in a **fresh**
   Safe Mode session with no concurrent configuration changes. Prepare the fresh
   disabled interface first; start a new Safe Mode history for the reviewed block.
   `dry-run` is a standalone flag. Source tests/rendering do not prove RouterOS
   import syntax or runtime behavior. A partial apply stays disabled and needs
   inspection; do not remove safeguards to force a retry.
4. Confirm the selected native services and their existing source restrictions
   permit the intended hub source. The planner never enables services, changes
   passwords/certificates or broadens service-address restrictions. For vendor
   devices, inspect LAN-only management behavior and redirects at the chosen IP.
5. Compare the full existing Tailscale policy and advertisement snapshot. Grants
   are additive: a narrow new grant cannot cancel a broad existing grant. Retain
   unrelated policy, test a real unapproved identity, and separately approve the
   new `/32` routes. `--advertise-routes` replaces its entire list; regenerate if
   the snapshot has changed. Verify the exact expected hub StableNodeID.
6. From a different WiFi network or mobile data, run the Mac checker with the
   private manifest, then log into every listed native interface and verify its
   physical identity. A successful socket, HTTP response or ping is connectivity
   evidence only. Use an IP in WinBox; this is not a MAC-discovery bridge.
7. Prove selected services, denied other targets/ports, customer isolation,
   transfer sizes/MTU, unchanged local networking, and reconnection after hub,
   gateway and CPE restart. Keep uninspected Mercusys mode/address mappings out
   of the plan. Gateways and radio links remain dependencies for devices behind
   them; this does not supply independent out-of-band access.

Firmware maintenance uses the correct native vendor workflow after checking
hardware/firmware compatibility, backups and recovery. There is no automated
firmware upload or reboot in this planner. Connectivity through a gateway does
not guarantee recovery if that gateway or radio link fails during an upgrade.

For revocation, remove only the new route approvals/grants, stop the dedicated
hub tunnel, and review the exact router rollback from local recovery. Keep its
disabled interface/private key for inspection. Restore a previous advertisement
list only after preserving any later unrelated additions. Never clear shared
firewall rules or connection tracking globally. A partial apply requires
inspection of the individually tagged records rather than this complete-apply
rollback script.

## Source verification

```sh
node --test pasofi-backend/infra/remote-access/network/*.test.mjs
sh pasofi-backend/infra/remote-access/network/check-nft.sh
```

The Node suite tests rendered packet scope/order, replies, source NAT, multiple
peers, overlap rejection, route preservation, private output and the actual
Node-to-Python manifest contract. The latter imports the sibling Mac checker and
fails if it is absent; it never silently skips. Separate worktree development can
set `PASOFI_OWNER_MAC_CHECKER` to the exact reviewed checker file.
The shell gate needs Linux `nft`, `unshare` and root/passwordless sudo and uses
only a disposable network namespace. Neither test path contacts a physical
device, changes the host firewall or proves an external-network session.

Primary references: [RouterOS WireGuard](https://manual.mikrotik.com/docs/virtual-private-networks/wireguard/),
[RouterOS 7.25 IP services](https://manual.mikrotik.com/docs/7.25/cli-reference/ip/service/),
[RouterOS packet flow](https://help.mikrotik.com/docs/spaces/ROS/pages/328227/Packet+Flow+in+RouterOS),
[RouterOS NAT](https://help.mikrotik.com/docs/spaces/ROS/pages/3211299/NAT),
[RouterOS Safe Mode](https://help.mikrotik.com/docs/spaces/ROS/pages/8978498/Console),
[Tailscale subnet routers](https://tailscale.com/docs/features/subnet-routers),
[Tailscale grants](https://tailscale.com/docs/reference/syntax/grants),
and [nftables hook priorities](https://wiki.nftables.org/wiki-nftables/index.php/Netfilter_hooks).
