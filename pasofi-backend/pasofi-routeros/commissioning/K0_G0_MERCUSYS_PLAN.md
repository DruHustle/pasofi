# K0 and G0 commissioning — current wiring, 17 November 2026

**Latest correction:** K0 LAN4 is EMPTY. Never add G0 to K0 LAN4, K0 guest bridge or downstream NAT. Old diagrams showing CPE1/CPE2 to G3 are superseded by the owner-reported G0 LAN1 to G2, then G2 LAN1 to G3 chain.

Kuwadzana: Starlink -> K0 hEX; K0 LAN1/ether2 -> K1 hAP lite, LAN2/ether3 -> K2 Tenda OS3, LAN3/ether4 -> K3 Tenda OS3, LAN4/ether5 -> empty.

Separate G0 chain: G0 hAP lite LAN1/ether2 -> G2 Mercusys MR20; G2 LAN1 -> G3 Mercusys MR20. G0 internet uplink, remote access and receiving G2/G3 port numbers are unknown.

## Read-only checks (never trust a wiring report as live configuration)

1. Use a trusted local session to run K0_FIRST_CONTACT.rsc on the hEX and G0_FIRST_CONTACT.rsc on the hAP lite. Never post full private output to public GitHub or chat.
2. Inspect actual port link and RouterOS bridge membership, WAN routes, DHCP, NAT, HotSpot and existing NAS registration. Confirm K0 ether5 is empty. Tailscale requires an authenticated route to a real management listener; a connected device alone does not prove access.
3. Verify OS3 K2/K3 can serve client phones and pass per-client traffic transparently. Verify G2/G3 are truly AP/bridge mode and that their uplink ports do not contend with the reported LAN1 link.
4. Take off-repository backups, preserve local recovery path and RouterOS Safe Mode before making any changes. Do not run a blanket reset or rename historical NAS IDs.
5. After evidence, prepare a device-specific K0 guest bridge for ether2-ether4 only, with one HotSpot/RADIUS owner. Keep ether1 as WAN and ether5 unassigned. G0 receives a separate plan only after its actual upstream is verified.
6. Real-device acceptance: phone with cellular data disabled, cash voucher purchase, captive redirect, authentication, HTTPS browsing, accounting Start/Interim/Stop, quota cutoff, reconnect, and no bypass from K1/K2/K3/G2/G3.

This document does not authorize production service activation, payments or automatic router writes.
