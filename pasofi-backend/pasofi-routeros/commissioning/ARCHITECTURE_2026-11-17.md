# PasoFi field architecture — updated 17 November 2026

**A design, not a verified network configuration.** Solid arrows indicate intended physical Ethernet connections as reported by the owner; dotted arrows indicate wireless links or intended repeaters. K4/K5 radio uplink source and all router firmware, RF, live NAS and cabling must still be inspected. Do not import historical hAP-lite gateway scripts onto the new K0 hEX.

## Kuwadzana — K0 gateway and directional/indoor extensions

```mermaid
flowchart TB
  KS["Starlink"] --> K0["K0 · MikroTik hEX
  Captive portal + RADIUS gateway"]
  K0 -->|"LAN1 · Ethernet"| K1["K1 · MikroTik hAP lite
  2.4 GHz guest AP"]
  K0 -->|"LAN2 · Ethernet (to verify)"| K2["K2 · Tenda O1-5G
  5 GHz directional phone-facing AP"]
  K0 -->|"LAN3 · Ethernet (to verify)"| K3["K3 · Tenda O1-5G
  5 GHz directional phone-facing AP"]
  K0 -.- KLAN4["LAN4 reserved
  No K4 cable"]
  K1 --> PH1["Phones · 2.4 GHz"]
  K2 --> PH2["Phones · narrow 5 GHz sector"]
  K3 --> PH3["Phones · narrow 5 GHz sector"]
  UK4["Wireless upstream TBD"] -. "Repeater link · unverified" .-> K4["K4 · Technicolor TG789vac v2
  Wireless repeater"]
  UK5["Wireless upstream TBD"] -. "2.4 GHz/WDS · unverified" .-> K5["K5 · Mercusys MW301R
  2.4 GHz repeater"]
  K4 -.-> PH4["Indoor phones"]
  K5 -.-> PH5["Different-room phones"]
```

**Important:** K2/K3 are 5 GHz **directional CPEs**, not omnidirectional outdoor sector/mesh APs. Tenda advertises a roughly **30° beam** on both O1-5G and OS3. The advertising claim of 1+ km (O1-5G) or 5+ km (OS3) describes a *CPE-to-CPE link* under suitable conditions, not the distance that a normal phone can reliably transmit back to a CPE. Test customer signal in both directions and actual HotSpot visibility across the planned 30° sectors.

**K4 and K5 have no Ethernet link to K0 LAN4.** They are owner-described wireless repeaters; their actual upstream AP, repeater/WDS firmware mode, transparent MAC/IPv4 forwarding and radio channel have not been verified. MW301R is 2.4 GHz only; TG789vac v2 may not offer compatible wireless repeater mode on every firmware. Do not enable an independent DHCP/NAT or uncontrolled bridge that bypasses the K0 HotSpot.

## Goromonzi — G0 gateway, home separate, CPE backhaul preserved

```mermaid
flowchart TB
  GS["Starlink"] --> G0["G0 · MikroTik hAP lite
  Captive portal + RADIUS gateway"]
  G0 -->|"LAN1 · home isolated"| G1["G1 · Home AP"]
  G0 -->|"LAN2 · wired guest backhaul"| C1["CPE1 · Tenda OS3 5 GHz AP
  Hardware revision to inspect"]
  C1 -->|"Existing 5 GHz radio link · preserve"| C2["CPE2 · Tenda OS3 client"]
  C2 -->|"Ethernet"| G3["G3 · Mercusys MR20 AC750
  Guest AP mode"]
  C1 -. "Planned second 5 GHz client" .-> RX["G2-RX · compatible client CPE
  Not installed/qualified"]
  RX -. "Ethernet after qualification" .-> G2["G2 · Mercusys MR20 AC750
  Guest AP mode"]
  G3 --> P3["Customer phones"]
  G2 --> P2["Customer phones · pending"]
```

The MR20 supports **AP** and **Range Extender** modes; the latter does not prove the necessary transparent Layer 2 behavior for MikroTik HotSpot per-client accounting or that the OS3's existing CPE2 remains associated. Prefer a separately tested 5 GHz receiving CPE on G2 and an Ethernet-fed MR20. Do not change CPE1's radio mode while it is carrying G3 traffic without independent management/rollback.

## Should we swap the Tenda radios?

| Attribute | Tenda O1-5G (K2/K3) | Tenda OS3 (CPE1/CPE2 Goromonzi) |
| --- | --- | --- |
| Use case | Directional outdoor PtP/PtMP bridge; short directed phone-facing use *only after field tests* | Directional outdoor PtP/PtMP bridge |
| Advertised link reach | 1+ km **between compatible CPEs** | 5+ km **between compatible CPEs** |
| Antenna / horizontal width | 9 dBi / 30° | 12 dBi / 30° |
| Wired interface | 1 × 10/100 Mbps | 4 × 10/100 Mbps |
| Practical phone coverage | Narrow sector; phone transmit power usually limits far-end return path | Same narrow sector; 12 dBi does not make it omnidirectional |
| Current role | K2/K3 reported phone-facing access points | Existing CPE1–CPE2 live Goromonzi bridge; preserve |

**Recommendation:** Do **not** exchange OS3 and O1-5G solely on advertised 1 km versus 5 km range. Current Goromonzi OS3 pair is carrying the known CPE1→CPE2→G3 path and should remain until a replacement is staged. If actual Goromonzi backhaul is short, line-of-sight, and an O1-5G PtMP pair/trio passes *both G2 and G3* under simultaneous load, a controlled swap may later be justified. But the stronger OS3 is not automatically better for **general cellphone coverage** at Kuwadzana: both have narrow beams and 100 Mbps wired uplinks. For wider phone coverage, use omnidirectional or true sector access points instead of treating a long-range CPE as a full-circle hotspot.

**Operator checks before any swap:** measured CPE endpoints' separation, 5 GHz channel and spectrum, Fresnel clearance, receiver signal/dBm, throughput under simultaneous clients, local EIRP rules, MR20 firmware/mode, and baseline/restore of the existing OS3 pair. Compare line of sight and number of AP clients rather than headline range.

**Manufacturer sources:** [Tenda O1-5G technical page](https://www.tenda.cz/article/tenda-o1-5g-wireless-outdoor-cpe-5-ghz-9-dbi), [Tenda OS3 official specification](https://www.tendacn.com/cn/product/support/OS3), [Mercusys MR20 official modes](https://www.mercusys.com/en/product/wifi-router/mr20/v1/), [Mercusys MW301R V2 specification](https://www.mercusys.com/en/product/wifi-router/mw301r/v2/).

## Customer acceptance (unchanged)

Only **K0** and **G0** should be registered as paid HotSpot NAS gateways. Guest APs, CPEs and repeaters must not provide an unmetered alternative route, independent NAT/DHCP or another RADIUS source. On a phone with mobile data off, prove HTTPS login, the real cash-sale voucher, authenticated RADIUS session, upload/download Interim/Stop accounting and quota disconnect on each physical path. Repeat after roaming among K1–K5 and G2/G3 (where installed); inspect per-client MAC/IP visibility especially through wireless repeater modes. A green CI check is **not** evidence that any radio path or cash collection is operational.
