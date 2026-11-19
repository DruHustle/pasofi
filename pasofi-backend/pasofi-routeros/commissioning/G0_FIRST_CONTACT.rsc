# G0 Goromonzi read-only first-contact snapshot (observations 19 November 2026).
# Live: ether1 WAN DHCP 192.168.0.219/24 via main router 192.168.0.1; G0 LAN bridge 192.168.88.5/24.
# LAN1 ether2 now connected to CPE1, 100Mbps full-duplex. ether4 also active, far-end UNKNOWN.
# Earlier G0->G2->G3 wired path may have changed. Do not assume CPE1 connects to G2 without device-side verification.
# pfi-pilot-hotspot enabled on pfi-pilot-br, but pilot Wi-Fi is inactive and ether2 belongs to different bridge.
# Oracle and owner WireGuard peers handshake; the RADIUS comment says site01. Verify distinct NAS/site mapping before activation.
# READ ONLY. No writes, no raw exports, no passwords or keys. Keep this private topology output off public GitHub.
:put "PASOFI G0 READ-ONLY FIRST CONTACT - NO WRITES"
:do { /system identity print } on-error={ :put "identity unavailable" }
:do { /system routerboard print } on-error={ :put "routerboard unavailable" }
:do { /system resource print } on-error={ :put "resource unavailable" }
:do { /system device-mode print } on-error={ :put "device-mode unavailable" }
:do { /interface ethernet print } on-error={ :put "ethernet unavailable" }
:do { /interface ethernet monitor ether1 once } on-error={ :put "WAN link unavailable" }
:do { /interface ethernet monitor ether2 once } on-error={ :put "LAN1/CPE1 link unavailable" }
:do { /interface ethernet monitor ether4 once } on-error={ :put "LAN3 link unavailable" }
:do { /interface bridge print } on-error={ :put "bridge unavailable" }
:do { /interface bridge port print } on-error={ :put "bridge ports unavailable" }
:do { /interface list member print where list=WAN } on-error={ :put "WAN list unavailable" }
:do { /ip address print } on-error={ :put "addresses unavailable" }
:do { /ip route print } on-error={ :put "routes unavailable" }
:do { /ip dhcp-client print } on-error={ :put "DHCP client unavailable" }
:do { /ip dhcp-server print } on-error={ :put "DHCP servers unavailable" }
:do { /ip dhcp-server network print proplist=address,gateway,dns-server } on-error={ :put "DHCP gateway/DNS unavailable" }
:do { /ip dns print } on-error={ :put "DNS unavailable" }
:do { /ip firewall nat print } on-error={ :put "NAT unavailable" }
:do { /ip firewall filter print terse where chain=forward } on-error={ :put "forward filters unavailable" }
:do { /ip hotspot print proplist=name,interface,profile,disabled } on-error={ :put "HotSpot servers unavailable" }
:do { /ip hotspot profile print proplist=name,hotspot-address,dns-name,login-by,use-radius } on-error={ :put "HotSpot profiles unavailable" }
:do { /radius print proplist=service,address,src-address,disabled,comment } on-error={ :put "RADIUS inventory unavailable" }
:do { /interface wireguard peers print proplist=interface,allowed-address,last-handshake,rx,tx } on-error={ :put "WireGuard peer metadata unavailable" }
:do { /ip service print } on-error={ :put "management services unavailable" }
:put "G0 READ-ONLY FIRST CONTACT FINISHED: NO CHANGES"
