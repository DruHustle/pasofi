# PasoFi router commissioning — current and target kept separate

**As of 17 November 2026, current wiring: independent Starlink sites. This is not live RouterOS configuration evidence.**

## Current port contract

| Gateway | WAN | LAN1 | LAN2 | LAN3 | LAN4 |
|---|---|---|---|---|---|
| K0 MikroTik hEX | Starlink, `ether1` expected | K1 hAP lite, `ether2` | K2 OS3, `ether3` | K3 OS3, `ether4` | **Empty `ether5`** |
| G0 MikroTik hAP lite | Starlink, `ether1` expected | G2 MR20, `ether2` | Unreported | Unreported | Not a LAN on this model |

G2 LAN1 -> G3 MR20, presently **wired**. Do not replace this wiring during preliminary configuration.

## Owner-assigned management addresses (19 November 2026; intended, not live-verified)

| Device | Intended management address | Notes |
|---|---|---|
| K0 — main MikroTik hEX | `192.168.88.1` | Upstream gateway when G0 is **temporarily** connected to K0 at the same site |
| K1 — Kuwadzana hAP lite AP | `192.168.88.2` | Downstream AP management on the K0 LAN |
| G0 — Goromonzi hAP lite | `192.168.88.5` | Required management reachability; determine whether address is on G0's **WAN** or **bridge** before making changes |

These are the owner's **desired** addresses, not evidence of active routing, DHCP bindings or a permanent intersite link. G0 is normally an independent HotSpot/RADIUS NAS. K0 and G0 must not be assumed to share an uplink in their final deployments.

**G0 Internet-loss diagnosis when connected to a main router using `192.168.88.1/24`:**

- **If G0 remains a separate HotSpot gateway:** connect the main router's approved **trusted** upstream port to G0's reviewed WAN (normally `ether1`); if `192.168.88.5/24` is G0's WAN management IP, route via `192.168.88.1`. Its **downstream guest bridge must use a different, nonoverlapping subnet**, verified against all existing routes. Keep WAN out of the guest bridge; check the actual K0 HotSpot guest policy is **not** intercepting G0's uplink. Preserve the G0 captive portal, RADIUS, source NAT/forward policy and its independent rollback. Do not repurpose K0's reserved `ether5` without a reviewed port plan.
- **If G0 is explicitly repurposed as an AP only:** `192.168.88.5/24` belongs on its management bridge with gateway `192.168.88.1`. Removing G0's routed HotSpot, DHCP and NAT role would change the approved product architecture and requires separate owner review; **do not perform it just to obtain Internet**.
- **Never use `192.168.88.0/24` for both G0 WAN and G0 guest LAN.** An address being distinct (`.5` versus `.1`) does not make overlapping connected subnets routable.

First collect read-only G0 evidence from an authenticated local RouterOS terminal (sensitive output stays private):

```routeros
/system identity print
/interface ethernet monitor ether1 once
/interface bridge port print
/ip address print detail
/ip dhcp-client print detail
/ip route print detail where dst-address="0.0.0.0/0"
/ip dns print
/ip firewall nat print
/ping 192.168.88.1 count=3
/ping 1.1.1.1 count=3
:do { :put [:resolve example.com] } on-error={ :put "DNS_RESOLUTION_FAILED" }
```

If ether1 has no link, fix the upstream port/cable; if DHCP is unbound, inspect DHCP source and bridge mode; if K0 pings but 1.1.1.1 does not, inspect WAN/LAN overlap, active default route, K0 guest interception and NAT; if public ping succeeds but DNS fails, inspect resolver settings; if router pings but downstream phones fail, inspect G0 guest DHCP, masquerade, HotSpot/walled garden and firewall. Use off-device backup, physical recovery access and RouterOS Safe Mode before any approved change. **Do not claim G0 Internet restored or enable paid HotSpot from these intended addresses.**

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
