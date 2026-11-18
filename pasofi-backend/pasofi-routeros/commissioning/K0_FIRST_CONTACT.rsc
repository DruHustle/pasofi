# PasoFi K0 / MikroTik hEX — first-contact inventory ONLY
# SAFE: read-only observations for an uninspected hEX. No activation or writes.
# Run in a trusted, owner-controlled WinBox terminal or import locally.
# Treat the output as PRIVATE: serial, MAC addresses, topology and IPs.
# Do NOT paste full output into issues, PRs, chat, CI logs or public artifacts.
# This script does not validate identity, create a VPN, or set up paid Wi-Fi.
# Do not import the legacy hAP lite site-01 configuration onto K0.
:put "PASOFI K0 — READ-ONLY INVENTORY START (not customer acceptance)"
:put "=== Device name and board ==="
:do { /system identity print } on-error={ :put "identity query unavailable" }
:do { /system routerboard print } on-error={ :put "routerboard query unavailable" }
:do { /system resource print } on-error={ :put "resource query unavailable" }
:do { /system package print } on-error={ :put "package query unavailable" }
:do { /system device-mode print } on-error={ :put "device-mode query unavailable" }
:put "=== Ethernet and bridge membership (check actual WAN/LAN) ==="
:do { /interface ethernet print } on-error={ :put "ethernet query unavailable" }
:do { /interface bridge print } on-error={ :put "bridge query unavailable" }
:do { /interface bridge port print } on-error={ :put "bridge-port query unavailable" }
:do { /interface list member print } on-error={ :put "interface-list query unavailable" }
:put "=== Addresses, routes and DHCP (private output) ==="
:do { /ip address print } on-error={ :put "address query unavailable" }
:do { /ip route print } on-error={ :put "route query unavailable" }
:do { /ip dhcp-client print } on-error={ :put "dhcp-client query unavailable" }
:do { /ip dhcp-server print } on-error={ :put "dhcp-server query unavailable" }
:put "=== Service and HotSpot availability (metadata only) ==="
:do { /ip service print } on-error={ :put "service query unavailable" }
:do { /ip hotspot print } on-error={ :put "hotspot menu unavailable (check package)" }
:do { /ipv6 settings print } on-error={ :put "ipv6 settings query unavailable" }
:put "PASOFI K0 — READ-ONLY INVENTORY FINISHED"
:put "No configuration, remote access, RADIUS or customer internet was changed."
