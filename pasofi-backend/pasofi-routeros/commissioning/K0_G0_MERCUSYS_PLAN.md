# PasoFi router commissioning — current and target kept separate

**G0 live RouterOS readback on 19 November 2026:** WAN `ether1` obtained `192.168.0.219/24` from upstream main router `192.168.0.1`, with working Internet/DNS. G0 LAN bridge is `192.168.88.5/24`; the operator corrected its DHCP gateway/DNS to `.5`. `ether2` (LAN1) has a 100 Mbps link to newly attached **CPE1**, while `ether4` has a live link to an **unidentified** device. CPE1's receiving path, G2/G3 access, and any paid HotSpot session are not yet verified. Kuwadzana entries remain owner-reported and require independent readback.

## Current port contract

| Gateway | WAN | LAN1 | LAN2 | LAN3 | LAN4 |
|---|---|---|---|---|---|
| K0 MikroTik hEX | Starlink, `ether1` expected | K1 hAP lite, `ether2` | K2 OS3, `ether3` | K3 OS3, `ether4` | **Empty `ether5`** |
| G0 MikroTik hAP lite | Main router `192.168.0.1` → `ether1` (DHCP `192.168.0.219`) | **CPE1 on `ether2`, live Ethernet only** | `ether3` inactive at last readback | `ether4` linked; far-end unknown | Not a LAN on this model |

Previously reported G2 LAN1 → G3 MR20 as **wired**. After CPE1 was connected to G0 LAN1, the physical path from CPE1 to G2 has **not** been verified. Preserve any remaining wired G2–G3 link and never assume that CPE1 transparently forwards separate client MACs.

## Owner-assigned management addresses (19 November 2026; intended, not live-verified)

| Device | Intended management address | Notes |
|---|---|---|
| K0 — main MikroTik hEX | `192.168.88.1` | Upstream gateway when G0 is **temporarily** connected to K0 at the same site |
| K1 — Kuwadzana hAP lite AP | `192.168.88.2` | Downstream AP management on the K0 LAN |
| G0 — Goromonzi hAP lite | `192.168.88.5` | **Observed** on the G0 LAN `bridge`; working WAN is separately on `ether1` (`192.168.0.219/24`) |

K0/K1 addresses are owner-assigned; G0's bridge address and upstream WAN were verified from live RouterOS output. No permanent intersite link to K0 is demonstrated. G0 remains intended to be an independent HotSpot/RADIUS NAS.

**G0 diagnosis updated with live evidence:**

- **Observed G0 routed gateway:** Main router is `192.168.0.1` on G0 `ether1` (not K0 `192.168.88.1`). G0 pings the upstream and `1.1.1.1`, resolves DNS and has `ether1` in the WAN interface list with a masquerade rule. Existing `192.168.88.5/24` is on the **management bridge**, not the WAN. CPE1 enters via `ether2` on this same bridge. Do not move the existing pilot HotSpot onto it: `ether4` is also active, and bridge-management changes could cut remote access. Commission a separately reviewed customer bridge/VLAN and an independently tested management/recovery route first.
- **Do not repurpose G0 as an AP:** its WAN, routing and Oracle/owner WireGuard peers are functional. The upstream main-router address is `192.168.0.1`; K0's unrelated `192.168.88.1` must never be installed as G0's default gateway.
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

The router's upstream connectivity and DNS now test successfully. **Customer Internet through CPE1/G2, captive-portal enforcement, isolation and RADIUS accounting are still untested.** The currently enabled `pfi-pilot-hotspot` is bound to `pfi-pilot-br`, while CPE1 enters via `ether2` on the separate `bridge`; the pilot Wi-Fi port was inactive. Its profile advertises `https,trial` and `use-radius=yes`, but that is not evidence of prepaid customer access. The enabled RADIUS client is labelled `site01` at source `10.77.254.2`; both Oracle and owner tunnels have recently handshaken. Verify G0's NAS identity/Oracle registration and the site's trial/paid contract independently, **without removing or resetting any functioning WireGuard tunnel**.

## Future Goromonzi (not commissioned)

G0 LAN1 -> G1 (device TBD); G0 LAN2 -> CPE1 Tenda O1-5G; CPE1 -> G2 via an **unverified receiving path**; CPE1 5 GHz -> CPE2 Tenda O1-5G -> G3. Keep G1 and CPE1/CPE2 out of the *current* commissioning plan. Determine G2 receiver and PTMP limits before cutover.

## Safe RouterOS steps (device-specific)

1. Establish separate private management connections for K0 and G0; confirm actual routerboard serials, RouterOS model and package, management fallback, WAN route, interface name/bridge membership. A connected Ethernet cable or Tailscale machine presence alone is not authentication to a router. Use `K0_FIRST_CONTACT.rsc` or `G0_FIRST_CONTACT.rsc`; outputs contain private topology and must remain in protected operator storage.
2. Back up each router and verify rollback, SSH/WinBox and current customer connectivity. Do not reset, force-disable, enable HotSpot or modify a remote bridge during initial inventory.
3. Prepare a serial-pinned private `baseline.json` and commissioning plan through existing `prepare.mjs` tooling. Run the **site-wiring gate** before generating a reviewed package; it prevents K0 `ether5` and planned G0 CPE interfaces from being accidentally added to today's guest bridge.
4. For K0, the *intended* customer-facing interfaces are `ether2,ether3,ether4`. For G0 the **observed** CPE1 uplink is `ether2` on the **management** bridge; `ether4` also has a live, unidentified link. **Do not treat G0 `ether2` as a qualified guest interface** or move it into a new bridge without separately verifying the connected CPE, alternate management recovery and client isolation. The downstream G2/G3 pathway must be mapped with a phone before release.
5. On the actual MR20 firmware select the documented AP/bridge mode and verify no competing NAT/DHCP; test two independent phone MAC/IP identities. Test OS3 AP client compatibility at K2/K3.
6. Commission separate RouterOS captive portals, certificate trust, private RADIUS `/32` identity, interim accounting and disconnect controls only after source-pinned Oracle tests and operator-approved rollback.
7. Run one supervised cash sale with an approved agent/open shift/exact physical USD/stock, deliver and redeem one voucher, then test real HTTPS, accounting and quota on each site. Keep EcoCash SMS, Stripe, Apple Pay and Google Pay provider-gated until independent acceptance.

**No production changes are executed by these repository scripts.** Keep both sites NO GO until physical results are recorded.
