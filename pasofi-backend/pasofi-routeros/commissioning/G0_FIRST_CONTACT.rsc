# PasoFi G0 owner-reported separate chain: CURRENT G0 LAN1 -> G2, G2 LAN1 -> G3; future G1/CPE1/CPE2 NOT commissioned
# READ ONLY. G0 current upstream is owner-reported Starlink (verify live WAN). K0 LAN4 EMPTY. Private output: do not publish.
:put "PASOFI G0 READ-ONLY FIRST CONTACT - NO WRITES"
:do { /system identity print } on-error={ :put "identity unavailable" }
:do { /system routerboard print } on-error={ :put "routerboard unavailable" }
:do { /system resource print } on-error={ :put "resource unavailable" }
:do { /system device-mode print } on-error={ :put "device-mode unavailable" }
:do { /interface ethernet print } on-error={ :put "ethernet unavailable" }
:do { /interface bridge print } on-error={ :put "bridge unavailable" }
:do { /interface bridge port print } on-error={ :put "bridge ports unavailable" }
:do { /ip address print } on-error={ :put "addresses unavailable" }
:do { /ip route print } on-error={ :put "routes unavailable" }
:do { /ip dhcp-client print } on-error={ :put "dhcp client unavailable" }
:do { /ip dhcp-server print } on-error={ :put "dhcp server unavailable" }
:do { /ip firewall nat print } on-error={ :put "NAT unavailable" }
:do { /ip hotspot print } on-error={ :put "hotspot unavailable" }
:do { /ip service print } on-error={ :put "services unavailable" }
:put "G0 READ-ONLY FIRST CONTACT FINISHED: NO CHANGES"
