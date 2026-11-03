{
# KUWADZANA PREPARATION ONLY: use Safe Mode and keep an off-device backup.
# This is not a service activation or a physical acceptance test.
:if ([:len [/interface wireguard find where name="pamofi-service"]] != 1 || [/interface wireguard get [find where name="pamofi-service"] disabled] != false) do={ :error "Expected enabled site service tunnel" }
:if ([/interface wireguard get [find where name="pamofi-service"] public-key] != "AMJXVTVrpj0512Eoj5A6DWNAnjySBPF3VmzODGeN/FE=") do={ :error "This is not the reviewed Kuwadzana router" }
:if ([:len [/ip address find where interface="pamofi-service" and address="10.77.254.2/32"]] != 1) do={ :error "Site tunnel address differs" }
:if ([:len [/interface bridge find where name="pfi-pilot-br"]] != 1 || [/interface bridge get [find where name="pfi-pilot-br"] disabled] != true) do={ :error "Pilot bridge must be disabled" }
:if ([:len [/interface wireless find where name="pfi-pilot-wifi"]] != 1 || [/interface wireless get [find where name="pfi-pilot-wifi"] disabled] != true) do={ :error "Pilot Wi-Fi must be disabled" }
:if ([:len [/interface bridge port find where bridge="pfi-pilot-br"]] != 1 || [:len [/interface bridge port find where bridge="pfi-pilot-br" and interface="pfi-pilot-wifi"]] != 1) do={ :error "Pilot bridge membership differs" }
:if ([/interface wireless get [find where name="pfi-pilot-wifi"] default-forwarding] != false || [/interface wireless get [find where name="pfi-pilot-wifi"] wps-mode] != "disabled") do={ :error "Pilot wireless isolation settings differ" }
:if ([:len [/ip address find where interface="pfi-pilot-br" and address="10.77.10.1/24"]] != 1) do={ :error "Expected prepared pilot gateway missing" }
:if ([:len [/ip dhcp-server find where name="pfi-pilot-dhcp"]] != 1 || [/ip dhcp-server get [find where name="pfi-pilot-dhcp"] disabled] != true) do={ :error "Pilot DHCP must be disabled" }
:if ([:tostr [/ip dhcp-server get [find where name="pfi-pilot-dhcp"] interface]] != "pfi-pilot-br" || [:tostr [/ip dhcp-server get [find where name="pfi-pilot-dhcp"] address-pool]] != "pfi-pilot-pool") do={ :error "Pilot DHCP interface or pool differs" }
:if ([:len [/ip pool find where name="pfi-pilot-pool"]] != 1 || [:tostr [/ip pool get [find where name="pfi-pilot-pool"] ranges]] != "10.77.10.10-10.77.10.200") do={ :error "Pilot address pool differs" }
:if ([:len [/radius find]] != 1 || [:len [/radius find where comment="PamoFi site: radius site01"]] != 1 || [/radius get [find where comment="PamoFi site: radius site01"] disabled] != true) do={ :error "Site RADIUS client must be the only client and disabled" }
:if ([/radius get [find where comment="PamoFi site: radius site01"] address] != 10.77.254.1 || [/radius get [find where comment="PamoFi site: radius site01"] src-address] != 10.77.254.2 || [/radius get [find where comment="PamoFi site: radius site01"] require-message-auth] != "yes-for-request-resp") do={ :error "Site RADIUS settings differ" }
:if ([:tostr [/radius get [find where comment="PamoFi site: radius site01"] service]] != "hotspot" || [/radius get [find where comment="PamoFi site: radius site01"] authentication-port] != 1812 || [/radius get [find where comment="PamoFi site: radius site01"] accounting-port] != 1813) do={ :error "Site RADIUS service or ports differ" }
:if ([:len [/certificate find where name="pamofi-hotspot-onesaeu.p12_0"]] != 1 || [/certificate get [find where name="pamofi-hotspot-onesaeu.p12_0"] trusted] != true || [/certificate get [find where name="pamofi-hotspot-onesaeu.p12_0"] fingerprint] != "985a06a8afa387bdad5b174bc88dbe592902f0b7fb01e1a1897a18fe46ef1551") do={ :error "Expected reviewed hotspot certificate missing or changed" }
:if ([:len [/ip hotspot user find where name!="default-trial"]] != 0) do={ :error "Existing local hotspot users require review" }
:foreach pfiUser in=[/ip hotspot user find] do={ :if ([/ip hotspot user get $pfiUser default] != true) do={ :error "Unexpected non-default hotspot user" } }
:if ([:len [/ip firewall filter find where comment~"PamoFi pilot:" and action=drop]] != 4) do={ :error "Expected four pilot deny rules per IP family" }
:if ([:len [/ip firewall filter find where chain="input" and in-interface="pfi-pilot-br" and action=drop and comment~"PamoFi pilot: input in\$"]] != 1) do={ :error "Unexpected pilot deny rule" }
:if ([:len [/ip firewall filter find where chain="output" and out-interface="pfi-pilot-br" and action=drop and comment~"PamoFi pilot: output out\$"]] != 1) do={ :error "Unexpected pilot deny rule" }
:if ([:len [/ip firewall filter find where chain="forward" and in-interface="pfi-pilot-br" and action=drop and comment~"PamoFi pilot: forward in\$"]] != 1) do={ :error "Unexpected pilot deny rule" }
:if ([:len [/ip firewall filter find where chain="forward" and out-interface="pfi-pilot-br" and action=drop and comment~"PamoFi pilot: forward out\$"]] != 1) do={ :error "Unexpected pilot deny rule" }
:foreach pfiRule in=[/ip firewall filter find where comment~"PamoFi pilot:" and action=drop] do={ :if ([/ip firewall filter get $pfiRule disabled] = true) do={ :error "Pilot deny rule is disabled" } }
:if ([:len [/ipv6 firewall filter find where comment~"PamoFi pilot:" and action=drop]] != 4) do={ :error "Expected four pilot deny rules per IP family" }
:if ([:len [/ipv6 firewall filter find where chain="input" and in-interface="pfi-pilot-br" and action=drop and comment~"PamoFi pilot: input in\$"]] != 1) do={ :error "Unexpected pilot deny rule" }
:if ([:len [/ipv6 firewall filter find where chain="output" and out-interface="pfi-pilot-br" and action=drop and comment~"PamoFi pilot: output out\$"]] != 1) do={ :error "Unexpected pilot deny rule" }
:if ([:len [/ipv6 firewall filter find where chain="forward" and in-interface="pfi-pilot-br" and action=drop and comment~"PamoFi pilot: forward in\$"]] != 1) do={ :error "Unexpected pilot deny rule" }
:if ([:len [/ipv6 firewall filter find where chain="forward" and out-interface="pfi-pilot-br" and action=drop and comment~"PamoFi pilot: forward out\$"]] != 1) do={ :error "Unexpected pilot deny rule" }
:foreach pfiRule in=[/ipv6 firewall filter find where comment~"PamoFi pilot:" and action=drop] do={ :if ([/ipv6 firewall filter get $pfiRule disabled] = true) do={ :error "Pilot deny rule is disabled" } }
:local pfiHotspotCount [:len [/ip hotspot find where name="pfi-pilot-hotspot"]]
:local pfiProfileCount [:len [/ip hotspot profile find where name="pfi-pilot-https"]]
:if ($pfiHotspotCount != $pfiProfileCount || $pfiHotspotCount > 1) do={ :error "Partial hotspot state requires review" }
:if ($pfiHotspotCount = 0 && ([:len [/ip hotspot find]] != 0 || [:len [/ip dns static find where name="hotspot.pamofi.onesa.eu"]] != 0)) do={ :error "Existing hotspot or DNS state requires review" }
:if ($pfiHotspotCount = 1) do={
  :if ([:len [/ip hotspot find]] != 1 || [/ip hotspot get [find where name="pfi-pilot-hotspot"] disabled] != true || [:tostr [/ip hotspot get [find where name="pfi-pilot-hotspot"] interface]] != "pfi-pilot-br" || [:tostr [/ip hotspot get [find where name="pfi-pilot-hotspot"] profile]] != "pfi-pilot-https") do={ :error "Existing hotspot state differs" }
  :if ([:tostr [/ip hotspot profile get [find where name="pfi-pilot-https"] login-by]] != "https" || [/ip hotspot profile get [find where name="pfi-pilot-https"] use-radius] != true || [/ip hotspot profile get [find where name="pfi-pilot-https"] radius-accounting] != true || [:tostr [/ip hotspot profile get [find where name="pfi-pilot-https"] ssl-certificate]] != "pamofi-hotspot-onesaeu.p12_0" || [/ip hotspot profile get [find where name="pfi-pilot-https"] dns-name] != "hotspot.pamofi.onesa.eu") do={ :error "Existing HTTPS hotspot profile differs" }
}
:local pfiTorrentCount [:len [/ip firewall filter find where comment~"PamoFi torrent:"]]
:if ($pfiTorrentCount != 0 && $pfiTorrentCount != 2) do={ :error "Partial torrent policy requires review" }
:if ($pfiTorrentCount = 2) do={
  :local pfiTCP [/ip firewall filter find where comment~"PamoFi torrent: common tcp ports\$"]
  :if ([:len $pfiTCP] != 1) do={ :error "Torrent tcp rule differs" }
  :set pfiTCP ($pfiTCP->0)
  :if ([/ip firewall filter get $pfiTCP disabled] = true || [:tostr [/ip firewall filter get $pfiTCP action]] != "drop" || [:tostr [/ip firewall filter get $pfiTCP chain]] != "forward" || [:tostr [/ip firewall filter get $pfiTCP in-interface]] != "pfi-pilot-br" || [:tostr [/ip firewall filter get $pfiTCP protocol]] != "tcp") do={ :error "Torrent tcp rule settings differ" }
  :local pfiTCPPorts [:tostr [/ip firewall filter get $pfiTCP dst-port]]
  :if ($pfiTCPPorts != "6881-6999,51413" && $pfiTCPPorts != "51413,6881-6999") do={ :error "Torrent tcp ports differ" }
  :local pfiUDP [/ip firewall filter find where comment~"PamoFi torrent: common udp ports\$"]
  :if ([:len $pfiUDP] != 1) do={ :error "Torrent udp rule differs" }
  :set pfiUDP ($pfiUDP->0)
  :if ([/ip firewall filter get $pfiUDP disabled] = true || [:tostr [/ip firewall filter get $pfiUDP action]] != "drop" || [:tostr [/ip firewall filter get $pfiUDP chain]] != "forward" || [:tostr [/ip firewall filter get $pfiUDP in-interface]] != "pfi-pilot-br" || [:tostr [/ip firewall filter get $pfiUDP protocol]] != "udp") do={ :error "Torrent udp rule settings differ" }
  :local pfiUDPPorts [:tostr [/ip firewall filter get $pfiUDP dst-port]]
  :if ($pfiUDPPorts != "6881-6999,51413" && $pfiUDPPorts != "51413,6881-6999") do={ :error "Torrent udp ports differ" }
}
:if ($pfiHotspotCount = 0) do={
/ip hotspot profile add name="pfi-pilot-https" hotspot-address=10.77.10.1 dns-name="hotspot.pamofi.onesa.eu" login-by=https ssl-certificate="pamofi-hotspot-onesaeu.p12_0" use-radius=yes radius-accounting=yes radius-interim-update=1m
/ip hotspot add name="pfi-pilot-hotspot" interface="pfi-pilot-br" address-pool=none profile="pfi-pilot-https" disabled=yes
}
:if ($pfiTorrentCount = 0) do={
:if ([:len [/ip firewall filter find where chain="forward"]] > 0) do={ /ip firewall filter add chain=forward action=drop in-interface="pfi-pilot-br" protocol=tcp dst-port=6881-6999,51413 comment="PamoFi torrent: common tcp ports" place-before=([/ip firewall filter find where chain="forward"]->0) } else={ /ip firewall filter add chain=forward action=drop in-interface="pfi-pilot-br" protocol=tcp dst-port=6881-6999,51413 comment="PamoFi torrent: common tcp ports" }
:if ([:len [/ip firewall filter find where chain="forward"]] > 0) do={ /ip firewall filter add chain=forward action=drop in-interface="pfi-pilot-br" protocol=udp dst-port=6881-6999,51413 comment="PamoFi torrent: common udp ports" place-before=([/ip firewall filter find where chain="forward"]->0) } else={ /ip firewall filter add chain=forward action=drop in-interface="pfi-pilot-br" protocol=udp dst-port=6881-6999,51413 comment="PamoFi torrent: common udp ports" }
}
:put ("Kuwadzana hotspot disabled: " . [/ip hotspot get [find where name="pfi-pilot-hotspot"] disabled])
:put ("Kuwadzana Wi-Fi disabled: " . [/interface wireless get [find where name="pfi-pilot-wifi"] disabled])
:put ("Kuwadzana DHCP disabled: " . [/ip dhcp-server get [find where name="pfi-pilot-dhcp"] disabled])
:put ("Kuwadzana RADIUS disabled: " . [/radius get [find where comment="PamoFi site: radius site01"] disabled])
:put ("Kuwadzana torrent rules: " . [:len [/ip firewall filter find where comment~"PamoFi torrent:"]])
:put "Customer service is not enabled: complete controlled physical acceptance and operations first."
}
