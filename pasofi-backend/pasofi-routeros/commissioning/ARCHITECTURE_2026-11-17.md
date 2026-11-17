# PasoFi current reported cable topology — 17 November 2026

**Owner reports physical cabling, not validated RouterOS settings. This page supersedes earlier network maps. No live router writes or customer internet acceptance are implied.**

## Kuwadzana

    Starlink
       |
       v
    K0 MikroTik hEX
       +-- LAN1 (ether2) --> K1 hAP lite
       +-- LAN2 (ether3) --> K2 Tenda OS3, 5 GHz directional
       +-- LAN3 (ether4) --> K3 Tenda OS3, 5 GHz directional
       +-- LAN4 (ether5) --> EMPTY

K0 HotSpot/RADIUS is the intended sole NAS for K1/K2/K3 customers, pending live inspection. OS3 units at K2/K3 are now **owner-reported connected**, not a future transfer; 5 GHz phone association, throughput, individual MAC visibility, DHCP and traffic isolation still require tests. K4 Technicolor and K5 Mercusys wireless repeaters are outside K0 LAN4; their radio uplinks remain unverified.

## Separate G0 chain — upstream unknown

    G0 MikroTik hAP lite (WAN/Internet not confirmed)
       +-- LAN1 (ether2) --> G2 Mercusys MR20
                                 +-- LAN1 --> G3 Mercusys MR20

G0 is **not connected to K0 LAN4**. The receiving ports on G2 and G3 are unknown. Actual MR20 AP mode, transparent forwarding and absence of NAT/DHCP are not remotely verified. Previous CPE1/CPE2/G1 records are historical, not a verified current link. Preserve existing site IDs and NAS identities.

## Required checks before device changes

1. Read actual K0 and G0 RouterOS model, bridge, port membership, WAN and management safely with read-only inventory scripts.
2. Keep K0 ether1 WAN and local WinBox access; do not bridge or assign ether5 to customers. Do not import old hAP lite site-01 scripts onto hEX.
3. Verify K1/K2/K3 transparent guest AP operation and client MAC/IP visibility, and then G2/G3 after G0 actual upstream is known. No second DHCP, HotSpot or NAT at downstream APs.
4. Only then prepare device-specific RouterOS changes with backups, Safe Mode and rollback.
5. Test a real paid-cash voucher, customer browsing, RADIUS Start/Interim/Stop accounting, quota disconnect and reconnect per physical access path. Until proven: **NO GO**.
