# Lawfield Farm router preparation

The Lawfield Farm location exists in Pasofi as an inactive site. The router's
model, current configuration and uplink have not yet been inspected. Do not
reuse site 1's router private key, shared RADIUS secret, tunnel address or
assumptions about its network.

The owner reports a temporary bench connection from a Kuwadzana LAN port to
Lawfield's `ether1`. Verify the port labels and inspect both the WAN and LAN
routes: default `192.168.88.0/24` networks on both sides would overlap. This
bench path does not establish the planned Starlink uplink at Lawfield Farm.

`lawfield-prepare.rsc` is a **first-stage script**, not a complete installation.
After taking an off-router password-protected backup, review the script and
use RouterOS Safe Mode. It reports non-secret network inventory and creates one
disabled WireGuard interface, with a unique private key generated and retained
by the router. Its printed public key is safe to share for generating the
site-specific Oracle peer. It refuses a missing HotSpot package, an existing
interface name or a WireGuard listen-port collision and makes no HotSpot, firewall, address, peer,
route, RADIUS or customer-access changes.

Before site 2 can operate, prepare and test an independent server peer and
firewall scope, NAS identity and secret, TLS certificate, non-overlapping guest
network and HotSpot profile. Verify the actual router and uplink, local recovery,
private transport, access denial, accounting, quotas, restart and reconnection.
Do not advertise Lawfield Farm as available until those tests pass.

## Continue with the existing site-link and RADIUS generators

The bootstrap creates `pasofi-service`. Preserve that name and its private key
when preparing the subsequent [site-link plan](../../infra/site-link/README.md).
Add `"routerInterface": "pasofi-service"` to the public plan JSON alongside the
inspected site-02 addresses, route inventories and independently generated
public keys. The older `pamofi-service` default belongs to the existing site-01
workflow; do not omit the interface field for this bootstrap or rename its
interface to work around a mismatch.

The bootstrap's local WireGuard listener is `51821`; record it as
`"routerListenPort": 51821`. The public plan's `port` is the selected Oracle
listener and peer endpoint port. Allocate that server port independently from
the inspected host's existing listeners, including site 1, before preparing
another dedicated server interface. Do not reuse the first site's listener or
open a new port without completing the corresponding host/cloud plan.

After qualifying that private link, use the [RADIUS client generator](../../infra/radius-production/README.md#router-client-preparation)
with the same interface name as its final argument:

```sh
node pasofi-backend/infra/radius-production/router-plan.mjs \
  site02 SERVER_TUNNEL_IP ROUTER_TUNNEL_IP /protected/pfi-radius-site02.secret \
  /protected/lawfield-radius-review.rsc pasofi-service
```

Replace the address placeholders with the reviewed site-02 values; the example
does not allocate them. Use site 2's own protected secret. Both generated
preflights refuse ambiguous state containing `pamofi-service` and
`pasofi-service` together. The RADIUS client remains disabled, and neither
generator prepares the customer bridge, DHCP, HotSpot or paid-service policy.

`lawfield-pilot-login.html` is the offline, Lawfield-branded draft login page.
It is not installed: the hostname, certificate, local network and login flow
must first be verified on the actual Lawfield router. It does not create a
HotSpot, permit internet access or enable sales. Preserve the existing RouterOS
HotSpot directory and DHCP captive-discovery assets when preparing installation.

For the current blue/lime welcome flow, use the [site-aware welcome installer](../portal/welcome/README.md#select-the-site-and-verified-portal-origins)
after the site's HTTPS profile and dedicated customer portal have been
qualified. Set `siteLabel` to the inspected location and supply its exact
HotSpot and app origins. The installer generates the label and links
consistently; it does not turn on the free trial, allow forwarding or qualify
paid service. Keep the previous portal directory for rollback.
