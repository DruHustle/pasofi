# PasoFi device access

## Device whitelist

In **PasoFi Staff → Routers**, select the enrolled router and a **Device whitelist** configuration area. Add or remove one MAC address, enter a reason, review the change and apply it. The existing router change history records the administrator, the selected HotSpot, and the verified result. Apply requires approved staff administrator access through the fleet's existing verification and write controls.

The entry exempts a device from the captive portal on the selected HotSpot. Use the device address observed there. A phone using a fixed private address may have a different address on another network. Use whitelisting only for devices approved for direct internet access. A device MAC can be copied. Feed cameras and appliances into the separate IoT network for network isolation.

Enroll only a verified guest HotSpot in the private fleet registry. Example targets for the previously inspected router profiles are:

| Router | Target |
| --- | --- |
| G0 guest Wi-Fi | `{"key":"guest-wifi-devices","kind":"device-whitelist","name":"pfi-pilot-hotspot"}` |
| G0 wired guests | `{"key":"guest-lan-devices","kind":"device-whitelist","name":"pfi-g0-lan"}` |
| K0 / K1 guest VLAN | `{"key":"guest-vlan-devices","kind":"device-whitelist","name":"pfi-guest20"}` |

Confirm the deployed server name and reachability before enrollment. Verify that the guest firewall blocks access to management and private networks independently of HotSpot authorization. Existing manual IP bindings remain operator-owned. The application creates MAC-only entries tagged `PasoFi admin device whitelist` for the enrolled HotSpot. Keep router FastTrack and IPv6 forwarding outside the customer path. Before enabling writes, use a disposable device to verify that adding and removing its entry changes access as expected, including removal during an existing connection.

## G0 camera and IoT Wi-Fi

`G0_IOT.rsc` prepares **PasoFi-IoT** as a separate 2.4 GHz WPA2 network on G0's existing access-point radio. It uses `10.81.30.0/24`, its own DHCP server and outbound internet access. Firewall rules restrict router access to DHCP and DNS, block guest and upstream private networks, and block inbound and IPv6 forwarding. The existing customer SSID and wired ports retain their settings.

1. Check the current G0 identity, active `wlan1` AP mode, `ether1` WAN, subnet availability and recovery access. Confirm `10.81.30.0/24` is unused across attached networks. Keep the IoT interface outside the interface lists for management, neighbor discovery, MAC-Telnet and MAC-WinBox.
2. In RouterOS, create a security profile named `pfi-iot-security` with **WPA2 PSK**, AES-CCM and a unique passphrase of at least 16 characters. Set the passphrase on the router.
3. Import the reviewed script with RouterOS dry-run validation. Then import it in Safe Mode and inspect the separate bridge, DHCP scope and rule order. The script leaves the new radio disabled.
4. Enable `pfi-iot-wifi` for a controlled test. Verify that a camera gets a `10.81.30.x` DHCP lease and can reach its required internet service. Confirm that it cannot reach guest devices, router administration or other clients on PasoFi-IoT. Confirm that a guest still lands on the PasoFi captive portal. Release Safe Mode after these checks pass.

K0 has no radio. A Kuwadzana IoT SSID needs a qualified isolated uplink to an AP that can map it to a separate network.
