# PasoFi — current physical topology versus final radio design (17 November 2026)

**Current wiring is owner-reported, not verified RouterOS configuration.** Two independent Starlink sites. No device was reconfigured by this change.

## Kuwadzana: CURRENT

```text
Starlink -> K0 (MikroTik hEX)
            LAN1 / ether2 -> K1 (MikroTik hAP lite)
            LAN2 / ether3 -> K2 (Tenda OS3, 5 GHz directional)
            LAN3 / ether4 -> K3 (Tenda OS3, 5 GHz directional)
            LAN4 / ether5 -> EMPTY
```

K0 is the intended HotSpot/RADIUS gateway for K1–K3. OS3 radio modes, smartphone reception, bridge membership, router identity, WAN and customer accounting are still to be inspected. K4 Technicolor TG789vac v2 and K5 Mercusys MW301R have not been reported on any K0 Ethernet port; wireless upstreams remain unverified.

## Goromonzi: CURRENT (preserve)

```text
Starlink -> G0 (MikroTik hAP lite, WAN port to verify)
            LAN1 / ether2 -> G2 (Mercusys MR20)
                              G2 LAN1 -> G3 (Mercusys MR20)
```

Currently G0–G2–G3 is **wired Ethernet**. The actual receiving MR20 ports, operating mode, client-MAC transparency, DHCP/NAT state and internet access must be tested. G0 LAN2/LAN3 have not been inventoried; the description does not reserve or disable them.

## Goromonzi: FINAL TARGET (not currently installed)

```text
Starlink -> G0 (MikroTik hAP lite)
            LAN1 -> G1 (home AP, model TBD)
            LAN2 -> CPE1 (Tenda O1-5G, 5 GHz AP)
                    +-> G2 (MR20, receiving link TBD)
                    +-> wireless -> CPE2 (Tenda O1-5G) -> G3 (MR20)
```

CPE1 has only one Ethernet uplink, so the connection to G2 must be separately designed: a compatible 5 GHz receiving CPE or independently validated alternative is required. **Do not assume that G2 can join the bridge with a normal Wi-Fi router or that the O1-5G pair alone supplies a third receiving device.** Existing wired G0→G2→G3 must stay operational until the alternative is proved and rollback is prepared.

## Invariants for RouterOS configuration

- Never connect G0 to K0 LAN4. Each site uses its own Starlink and its own registered RADIUS NAS.
- Keep K0 WAN outside the guest bridge and K0 LAN4 empty and outside the bridge.
- K1/K2/K3 and G2/G3 are downstream transparent APs, not independent HotSpot/NAT/DHCP/RADIUS gateways.
- Do not blindly import the historical `site-01` hAP-lite script onto the new hEX; verify device serial, RouterOS architecture, HotSpot capability and protected management paths first.
- No current-to-planned G0 cutover before real CPE signal, bridge transparency, client IP/MAC and full quota-accounting evidence.
- Physical payment-service GO requires an actual cash voucher, authenticated RADIUS session, HTTPS use, Start/Interim/Stop, quota cutoff, and reconnect on each customer path.

Read the machine-readable [topology](topology.target.json), [acceptance record](ACCEPTANCE.md) and [commissioning sequence](K0_G0_MERCUSYS_PLAN.md).
