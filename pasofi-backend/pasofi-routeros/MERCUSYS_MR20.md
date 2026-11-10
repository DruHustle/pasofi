# Mercusys MR20 access points behind a Pasofi gateway

Use the MR20 as an access point on an inspected MikroTik customer network.
The MikroTik remains responsible for captive login, RADIUS and quota enforcement.
This guide contains no site addresses, credentials or ready-to-import router
configuration. It does not establish that any physical installation is qualified.

## Choose the documented operating mode

Mercusys lists native Access Point mode for the
[MR20 V1](https://www.mercusys.com/en/product/wifi-router/mr20/v1/) and
[V2](https://www.mercusys.com/en/product/wifi-router/mr20/v2/).
Record the actual hardware revision, firmware and current mode first.
The [MR20 user guide, section 2.2.2](https://static.mercusys.com/manual/1910080068_MR20_User_Guide_REV1.0.020211103064945.pdf)
recommends the upstream router's LAN connection to the MR20 **WAN** port when
using native AP mode. Its interface uses **Change Mode → Access Point Mode**,
with **System → Operation Mode** described in the configuration chapter.

The [Mercusys AP setup guide](https://www.mercusys.com/de/faq-123/) gives a
different LAN-to-LAN and DHCP-off procedure for devices **without** an Operation
Mode menu. Do not combine that fallback with the native procedure. Use the
instructions that match the inspected hardware and firmware.

## Preserve the gateway's client visibility

| Component | Responsibility |
| --- | --- |
| MikroTik gateway | Customer addressing, HotSpot, trusted HTTPS login, private RADIUS transport, metering and enforcement |
| MR20 access point | Forward each wireless client's traffic onto the selected customer network |
| Pasofi backend | Customer identity, paid entitlement, accounting ledger and authorized operations |

An extra NAT layer between phones and their HotSpot gateway can conceal
individual downstream clients. Verify transparent forwarding with two actual
phones; do not infer it solely from a selected AP-mode label. Inspect the
gateway's host records, client IP/MAC identities and DHCP leases.

When the customer network uses a bridge, bind HotSpot to the bridge interface
and keep public/uplink interfaces out of that customer bridge, as specified by
the [RouterOS HotSpot manual](https://manual.mikrotik.com/docs/authentication-authorization-accounting/hotspot-captive-portal/).
Do not infer RouterOS `etherN` names from printed LAN port labels. If two
MikroTiks are cabled together, first establish which link is transit and which
gateway owns each customer subnet. Passing customers through two captive
portals or merging management and customer networks is not an acceptable
substitute for that inventory.

## Commission one access point at a time

1. Read the MikroTik interface, bridge/VLAN, addressing, routes, DHCP, firewall,
   HotSpot and management state. Read the MR20's version, mode, management
   address and connected port. Retain the verified management path.
2. Select the matching native AP procedure and the inspected customer-network
   port. After any mode change, discover the resulting management address from
   verified leases or inventory; do not reuse a remembered address blindly.
3. Join two test phones. Confirm separate host records and working DHCP/DNS.
   Test the trusted HTTPS portal and the separately bounded welcome allowance.
4. Run paid login and Start/interim/Stop accounting with controlled test access.
   Measure upload and download separately, exhaust a small test quota, and
   confirm actual cutoff, disconnect and reconnect. An application receipt or
   an accepted RADIUS request alone does not prove Internet access.
5. Repeat on the second access point and while moving between them. Verify that
   account/session limits and remaining allowance persist without duplicate
   grants or another unmetered route.
6. Test guest-to-guest and guest-to-management isolation, restart and upstream
   interruption. Keep the qualified IPv6 controls: RouterOS documents HotSpot
   enforcement as IPv4-dependent. Also test management access to the AP itself;
   traffic between wireless peers may never traverse the upstream gateway.

Use the existing [two-site acceptance record](../docs/TWO_SITE_HOTSPOT_ACCEPTANCE.md)
for the paid-service evidence, and the [welcome-page acceptance steps](portal/welcome/README.md)
for the independent free welcome. Record the actual inspected site names in
private commissioning evidence. Generic documentation and old preparation
filenames are not proof of a current device-to-site assignment.

## Release boundary

The website and the Oracle-hosted captive application are separate build
outputs. A Vercel release does not update the gateway's portal files. Follow
the [dedicated portal deployment guide](../infra/production/HOTSPOT_PORTAL.md)
and verify that the application remains reachable after welcome time expires.
Keep sales and paid-network activation separate until the physical tests pass.
