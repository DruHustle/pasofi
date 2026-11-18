# PasoFi router commissioning — current and target kept separate

**As of 17 November 2026, current wiring: independent Starlink sites. This is not live RouterOS configuration evidence.**

## Current port contract

| Gateway | WAN | LAN1 | LAN2 | LAN3 | LAN4 |
|---|---|---|---|---|---|
| K0 MikroTik hEX | Starlink, `ether1` expected | K1 hAP lite, `ether2` | K2 OS3, `ether3` | K3 OS3, `ether4` | **Empty `ether5`** |
| G0 MikroTik hAP lite | Starlink, `ether1` expected | G2 MR20, `ether2` | Unreported | Unreported | Not a LAN on this model |

G2 LAN1 -> G3 MR20, presently **wired**. Do not replace this wiring during preliminary configuration.

## Future Goromonzi (not commissioned)

G0 LAN1 -> G1 (device TBD); G0 LAN2 -> CPE1 Tenda O1-5G; CPE1 -> G2 via an **unverified receiving path**; CPE1 5 GHz -> CPE2 Tenda O1-5G -> G3. Keep G1 and CPE1/CPE2 out of the *current* commissioning plan. Determine G2 receiver and PTMP limits before cutover.

## Safe RouterOS steps (device-specific)

1. Establish separate private management connections for K0 and G0; confirm actual routerboard serials, RouterOS model and package, management fallback, WAN route, interface name/bridge membership. A connected Ethernet cable or Tailscale machine presence alone is not authentication to a router. Use `K0_FIRST_CONTACT.rsc` or `G0_FIRST_CONTACT.rsc`; outputs contain private topology and must remain in protected operator storage.
2. Back up each router and verify rollback, SSH/WinBox and current customer connectivity. Do not reset, force-disable, enable HotSpot or modify a remote bridge during initial inventory.
3. Prepare a serial-pinned private `baseline.json` and commissioning plan through existing `prepare.mjs` tooling. Run the **site-wiring gate** before generating a reviewed package; it prevents K0 `ether5` and planned G0 CPE interfaces from being accidentally added to today's guest bridge.
4. For K0, the *intended* customer-facing interfaces are `ether2,ether3,ether4`. For G0 CURRENT, only `ether2` feeds G2/G3. Real RouterOS interfaces must first match the inspected baseline and preserve management/recovery/WAN ports.
5. On the actual MR20 firmware select the documented AP/bridge mode and verify no competing NAT/DHCP; test two independent phone MAC/IP identities. Test OS3 AP client compatibility at K2/K3.
6. Commission separate RouterOS captive portals, certificate trust, private RADIUS `/32` identity, interim accounting and disconnect controls only after source-pinned Oracle tests and operator-approved rollback.
7. Run one supervised cash sale with an approved agent/open shift/exact physical USD/stock, deliver and redeem one voucher, then test real HTTPS, accounting and quota on each site. Keep EcoCash SMS, Stripe, Apple Pay and Google Pay provider-gated until independent acceptance.

**No production changes are executed by these repository scripts.** Keep both sites NO GO until physical results are recorded.
