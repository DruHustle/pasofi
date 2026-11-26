# Run in Safe Mode on the verified G0 hAP lite. The last step creates a disabled radio.
# Prepare the independent pfi-iot-security profile on the router before import.
{
:if ([/system identity get name] != "Router.Goromonzi-G0.Hotspot") do={ :error "Expected the G0 gateway" }
:local master [/interface wireless find where name="wlan1" and mode=ap-bridge and disabled=no]
:local wan [/interface list member find where list="WAN" and interface="ether1"]
:local security [/interface wireless security-profiles find where name="pfi-iot-security"]
:if (([:len $master] != 1) or ([:len $wan] != 1) or ([:len $security] != 1)) do={ :error "Verify G0 radio, uplink and IoT security profile" }
:if (([/interface wireless security-profiles get $security mode] != "dynamic-keys") or ([:tostr [/interface wireless security-profiles get $security authentication-types]] != "wpa2-psk") or ([:len [/interface wireless security-profiles get $security wpa2-pre-shared-key]] < 16)) do={ :error "Use WPA2-PSK with a distinct key of at least 16 characters" }
:if (![/ip dns get allow-remote-requests]) do={ :error "Verify G0 DNS service first" }
:if (([:len [/interface find where name="pfi-iot" or name="pfi-iot-wifi"]] != 0) or ([:len [/ip pool find where name="pfi-iot-pool"]] != 0) or ([:len [/ip dhcp-server find where name="pfi-iot-dhcp"]] != 0) or ([:len [/ip route find where dst-address="10.81.30.0/24"]] != 0) or ([:len [/ip dhcp-server network find where address="10.81.30.0/24"]] != 0) or ([:len [/ip firewall address-list find where list="pfi-iot-blocked"]] != 0)) do={ :error "Existing IoT resources or subnet need review" }
:local ipv4In [:pick [/ip firewall filter find where chain=input and dynamic=no] 0]
:local ipv4Forward [:pick [/ip firewall filter find where chain=forward and dynamic=no] 0]
:local ipv6In [:pick [/ipv6 firewall filter find where chain=input and dynamic=no] 0]
:local ipv6Forward [:pick [/ipv6 firewall filter find where chain=forward and dynamic=no] 0]
:if (([:len [:tostr $ipv4In]] = 0) or ([:len [:tostr $ipv4Forward]] = 0) or ([:len [:tostr $ipv6In]] = 0) or ([:len [:tostr $ipv6Forward]] = 0)) do={ :error "Verify the existing firewall chains first" }

/interface bridge add name=pfi-iot protocol-mode=rstp comment="PasoFi IoT"
/ip address add address=10.81.30.1/24 interface=pfi-iot comment="PasoFi IoT"
/ip pool add name=pfi-iot-pool ranges=10.81.30.20-10.81.30.199
/ip dhcp-server network add address=10.81.30.0/24 gateway=10.81.30.1 dns-server=10.81.30.1 comment="PasoFi IoT"
/ip dhcp-server add name=pfi-iot-dhcp interface=pfi-iot address-pool=pfi-iot-pool disabled=no

:foreach subnet in={"0.0.0.0/8";"10.0.0.0/8";"100.64.0.0/10";"127.0.0.0/8";"169.254.0.0/16";"172.16.0.0/12";"192.168.0.0/16";"224.0.0.0/4";"240.0.0.0/4"} do={ /ip firewall address-list add list=pfi-iot-blocked address=$subnet comment="PasoFi IoT" }
/ip firewall filter add chain=input action=accept in-interface=pfi-iot protocol=udp dst-port=67 place-before=$ipv4In comment="PasoFi IoT DHCP"
/ip firewall filter add chain=input action=accept in-interface=pfi-iot src-address=10.81.30.0/24 dst-address=10.81.30.1 protocol=udp dst-port=53 place-before=$ipv4In comment="PasoFi IoT UDP DNS"
/ip firewall filter add chain=input action=accept in-interface=pfi-iot src-address=10.81.30.0/24 dst-address=10.81.30.1 protocol=tcp dst-port=53 place-before=$ipv4In comment="PasoFi IoT TCP DNS"
/ip firewall filter add chain=input action=drop in-interface=pfi-iot place-before=$ipv4In comment="PasoFi IoT block router access"
/ip firewall filter add chain=forward action=drop in-interface=pfi-iot dst-address-list=pfi-iot-blocked place-before=$ipv4Forward comment="PasoFi IoT block private destinations"
/ip firewall filter add chain=forward action=accept in-interface=pfi-iot src-address=10.81.30.0/24 out-interface=ether1 connection-state=new,established,related place-before=$ipv4Forward comment="PasoFi IoT Internet"
/ip firewall filter add chain=forward action=drop in-interface=pfi-iot place-before=$ipv4Forward comment="PasoFi IoT block other forwarding"
/ip firewall filter add chain=forward action=accept in-interface=ether1 out-interface=pfi-iot dst-address=10.81.30.0/24 connection-state=established,related place-before=$ipv4Forward comment="PasoFi IoT Internet replies"
/ip firewall filter add chain=forward action=drop out-interface=pfi-iot place-before=$ipv4Forward comment="PasoFi IoT block inbound forwarding"
/ip firewall nat add chain=srcnat action=masquerade src-address=10.81.30.0/24 out-interface=ether1 comment="PasoFi IoT"
/ipv6 firewall filter add chain=input action=drop in-interface=pfi-iot place-before=$ipv6In comment="PasoFi IoT block IPv6 input"
/ipv6 firewall filter add chain=forward action=drop in-interface=pfi-iot place-before=$ipv6Forward comment="PasoFi IoT block IPv6 forwarding in"
/ipv6 firewall filter add chain=forward action=drop out-interface=pfi-iot place-before=$ipv6Forward comment="PasoFi IoT block IPv6 forwarding out"

/interface wireless add name=pfi-iot-wifi master-interface=wlan1 mode=ap-bridge ssid=PasoFi-IoT security-profile=pfi-iot-security default-forwarding=no disabled=yes comment="PasoFi IoT"
/interface bridge port add bridge=pfi-iot interface=pfi-iot-wifi
:put "PasoFi-IoT staged with the radio disabled"
}
