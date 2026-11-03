# Starlink site connection to Oracle

This prepares the **backend service connection**, separate from the owner-only
[remote-access planner](../remote-access/README.md). Production is Vercel for the
frontend, Oracle for backend services, and Starlink upstream of the MikroTik.

The MikroTik initiates WireGuard to a reachable Oracle UDP endpoint, with a
25-second keepalive. This supports an upstream NAT/CGNAT connection without
Starlink port forwarding or a static Starlink address. Customer internet traffic
continues through Starlink. Only the exact Oracle/router service `/32` addresses
are routed into the VPN; there is no default route, customer-LAN route, or
site-to-site forwarding.

Starlink documents default IPv4 CGNAT and no port-forwarding controls on its Wi-Fi
router. Bypass mode can remove the local router layer when appropriate to the
installed kit, but does not change the ISP's IPv4 policy. No bypass, paid plan,
public IP option or firmware change is needed by this outbound software design.
Actual UDP availability and reconnect behavior remain physical acceptance work.

## Prepare the first site

1. Inspect the chosen Oracle VM, existing interfaces, host firewall manager,
   Docker networks, private routes, public endpoint, and OCI security rules.
2. Inspect the MikroTik route inventory and ensure a working local recovery
   connection. Allocate a private address pair that overlaps neither inventory.
3. Generate WireGuard keys on their originating devices. The router needs one
   fresh **disabled** `pamofi-service` interface; retain its private key there.
   Retain the Oracle private key on Oracle. The JSON contains public keys only.
4. Copy `public-plan.example.json`, replace all placeholders, and supply complete
   current non-default IPv4 route inventories. The example cannot be deployed
   unchanged.

```sh
node pamofi-backend/infra/site-link/plan.mjs \
  /protected/public-site-plan.json /protected/new-site-review
```

The tool is offline. It writes a new mode0700 directory and mode0600 files,
refuses an existing output directory and does not contact any router/server.
The report remains **`prepared-only`**.

| Output | Purpose |
| --- | --- |
| `router-service.rsc.review` | Fresh-interface preflight, guarded `/32` routing and outbound peer; enablement is last |
| `oracle-wireguard.conf.review` | Dedicated Oracle interface and one NAS peer; the private-key placeholder must be replaced on Oracle |
| `oracle-firewall.nft.review` | Exact service traffic guards for integration with the inspected Oracle firewall |
| `review.json` | Scope, unknown deployment inputs and physical acceptance checks |

The script does not configure HotSpot, RADIUS shared secrets, HTTPS services,
service accounts, customer SSIDs, DHCP, NAT or the existing management LAN.
Those changes must use the selected actual site configuration later. In
particular, RouterOS RADIUS must use the **router tunnel address as its source**;
it must match the protected FreeRADIUS client entry and the network NAS registry.

## Traffic permitted by the plan

| Direction | Allowed inner traffic |
| --- | --- |
| MikroTik → Oracle | RADIUS authentication/accounting UDP1812/1813; established HTTPS management replies; diagnostic echo |
| Oracle → MikroTik | HTTPS management TCP443; established RADIUS replies from UDP1812/1813; diagnostic echo |
| Customer/home LAN ↔ VPN | Denied in both directions before existing RouterOS accepts/FastTrack |
| Inner IPv6 / other ports / other peers | Denied |

The router input guard explicitly permits established RADIUS replies before its
deny rule. Without that exception an owner-only management plan would block
accounting/authentication responses. HTTPS still requires a trusted RouterOS
certificate and restricted per-device service credentials; no TCP management
port is opened on the public internet by this plan.

Docker port publication performs destination NAT before ordinary host input
filtering. The Oracle review file therefore checks incoming inner traffic
**before DNAT** and outgoing traffic **after SNAT**. It permits only the reviewed
address pair, RADIUS ports and HTTPS direction. Packets targeting the Oracle
tunnel's UDP 1812/1813 bind from any other host interface are explicitly dropped.
It does not flush existing rules,
replace the host's firewall manager, or override a later drop in another chain.
Its `create table` refuses a table of the same name, and nft applies the batch
transactionally. Apply only after inspecting existing rules and compatibility.
Permit the WireGuard outer UDP port in the existing host input policy and OCI
NSG/security list separately. Publish RADIUS only on the Oracle tunnel address,
never on `0.0.0.0` or the VM's public/private-VCN address.

This first-site generator expects a fresh dedicated Linux interface. For another
site, review the existing hub/address allocation and firewall policy explicitly;
do not overwrite the first interface or advertise whole customer networks.
Owner access can be layered onto the reviewed Oracle management path with its
own authenticated account/policy; no owner or tailnet grant is created here.

## Onesa site-01 host guard

The `site01-firewall.sh` guard is deliberately pinned to the inspected Onesa
host: `enp0s6`, the existing `ONESA_WORKER_INPUT` chain, UDP 51821, interface
`pfi-site01`, and the reviewed nft batch for `10.77.254.1` and `10.77.254.2`.
It refuses a modified, symlinked, non-root-owned or writable batch, an existing
site interface, an existing guard table, or a duplicate transport rule. It
adds only its own nft table and exact tagged input rule; it does not replace or
save the shared firewall. Removal refuses while the site interface exists and
also refuses if interface inventory cannot be read. It closes its transport
rule before removing its table. A partially installed or
unexpected state requires operator inspection rather than automatic adoption.

The `pamofi-site01-guard.service` and `wg-quick-site01-guard.conf` files define
the intended dependency and ordering: the guard follows the existing persistent
firewall and precedes `wg-quick@pfi-site01`. The guard script expects the
reviewed batch at `/etc/pamofi/site01/guard.nft` and its installed script at
`/usr/local/lib/pamofi/site01-firewall.sh`. Those files and their parent
directories must be root-controlled; the WireGuard configuration and private
key must also be root-protected. Merely checking in these files does not install,
enable or start the service. Inspect the current host and cloud state again,
verify the actual site/peer and off-host key recovery, then follow a reviewed
installation and rollback procedure before activation.

## Qualification

```sh
node --test pamofi-backend/infra/site-link/plan.test.mjs
sh pamofi-backend/infra/site-link/check-nft.sh
sudo bash pamofi-backend/infra/site-link/test-site01-firewall.sh
```

The second command requires Linux `nft`, `unshare`, and root or passwordless sudo
for an **owned disposable network namespace**. It performs kernel-backed syntax
validation there and never modifies the host firewall. Unit tests cover the
outbound endpoint, reply allowances, rule ordering, IPv6/forward denial, private
files, no overwrite and invalid/injected/overlapping input rejection.

Physical qualification is intentionally later: RouterOS import dry-run; fresh
handshake; actual RADIUS source/reply traffic; certificate-verified HTTPS;
accounting and quota enforcement; forbidden-port/LAN/other-site denial; Starlink
outage/reconnection; router reboot and local recovery. Neither unit tests nor
Linux syntax validation execute RouterOS or establish a live tunnel.
Use the [production RADIUS authentication contract](../radius-production/README.md#hotspot-authentication-contract)
for HTTPS login/PAP qualification and actual upload/download accounting checks.

The site-01 host guard test also creates a disposable network namespace. It
checks the actual digest-pinned batch, rejection of altered files and existing
interfaces, duplicate-start refusal, refusal to remove a live interface's guard,
and preservation of an existing drop rule. It never modifies the host firewall.

References: [Starlink IP policy](https://starlink.com/support/article/1192f3ef-2a17-31d9-261a-a59d215629f4),
[Starlink VPN support](https://starlink.com/support/article/e5dc0b86-09b4-084b-918b-3fa181e5fb5d),
[MikroTik WireGuard](https://help.mikrotik.com/docs/spaces/ROS/pages/69664792/WireGuard),
[nftables hook priorities](https://wiki.nftables.org/wiki-nftables/index.php/Netfilter_hooks).
