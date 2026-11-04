# Lawfield Farm router preparation

The Lawfield Farm location exists in PasoFi as an inactive site. The router's
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

`lawfield-pilot-login.html` is the offline, Lawfield-branded draft login page.
It is not installed: the hostname, certificate, local network and login flow
must first be verified on the actual Lawfield router. It does not create a
HotSpot, permit internet access or enable sales. Preserve the existing RouterOS
HotSpot directory and DHCP captive-discovery assets when preparing installation.
