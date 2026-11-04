{
# Temporary isolated PasoFi pilot. Import only in Safe Mode on the identified
# Kuwadzana router. Internet forwarding and cash sales remain unavailable.
# Stop and roll back on an error; never retry after a disconnect without review.
:if ([:len [/interface wireguard find where name="pamofi-service" and disabled=no]] != 1) do={ :error "Expected active Kuwadzana tunnel" }
:if ([/interface wireguard get [find where name="pamofi-service"] public-key] != "AMJXVTVrpj0512Eoj5A6DWNAnjySBPF3VmzODGeN/FE=") do={ :error "Wrong router" }
:if ([:len [/interface bridge find where name="pfi-pilot-br" and disabled=yes]] != 1 || [:len [/interface wireless find where name="pfi-pilot-wifi" and disabled=yes]] != 1) do={ :error "Pilot bridge and radio must be disabled" }
:if ([:len [/interface bridge port find where bridge="pfi-pilot-br"]] != 1 || [:len [/interface bridge port find where bridge="pfi-pilot-br" and interface="pfi-pilot-wifi"]] != 1) do={ :error "Unexpected pilot bridge membership" }
:if ([:len [/interface list member find where interface="pfi-pilot-br" or interface="pfi-pilot-wifi"]] != 0) do={ :error "Pilot must not belong to a trusted interface list" }
:if ([:tostr [/tool mac-server get allowed-interface-list]] != "LAN" || [:tostr [/tool mac-server mac-winbox get allowed-interface-list]] != "LAN") do={ :error "Review MAC management access before continuing" }
:if ([/interface wireless get [find where name="pfi-pilot-wifi"] default-forwarding] != false || [/interface wireless get [find where name="pfi-pilot-wifi"] wps-mode] != "disabled") do={ :error "Wireless isolation differs" }
:if ([:len [/ip address find where interface="pfi-pilot-br" and address="10.77.10.1/24"]] != 1 || [:len [/ip dhcp-server find where name="pfi-pilot-dhcp" and interface="pfi-pilot-br" and disabled=yes]] != 1) do={ :error "Pilot gateway or DHCP differs" }
:if ([:len [/ip hotspot find where name="pfi-pilot-hotspot" and interface="pfi-pilot-br" and disabled=yes]] != 1) do={ :error "Expected disabled pilot HotSpot" }
:if ([:tostr [/ip hotspot get [find where name="pfi-pilot-hotspot"] profile]] != "pfi-pilot-https") do={ :error "Pilot HotSpot profile differs" }
:if ([:tostr [/ip hotspot profile get [find where name="pfi-pilot-https"] login-by]] != "https" || [/ip hotspot profile get [find where name="pfi-pilot-https"] use-radius] != true || [/ip hotspot profile get [find where name="pfi-pilot-https"] radius-accounting] != true) do={ :error "Pilot HTTPS or accounting profile differs" }
:if ([:tostr [/ip hotspot profile get [find where name="pfi-pilot-https"] ssl-certificate]] != "pamofi-hotspot-onesaeu.p12_0" || [/ip hotspot profile get [find where name="pfi-pilot-https"] dns-name] != "hotspot.pamofi.onesa.eu") do={ :error "Pilot certificate binding or hostname differs" }
:if ([:len [/certificate find where name="pamofi-hotspot-onesaeu.p12_0" and trusted=yes]] != 1 || [/certificate get [find where name="pamofi-hotspot-onesaeu.p12_0"] fingerprint] != "985a06a8afa387bdad5b174bc88dbe592902f0b7fb01e1a1897a18fe46ef1551") do={ :error "Expected pilot certificate missing or changed" }
:if ([:len [/radius find where comment="PamoFi site: radius site01" and disabled=yes]] != 1) do={ :error "Expected disabled site RADIUS client" }
:if ([/radius get [find where comment="PamoFi site: radius site01"] address] != 10.77.254.1 || [/radius get [find where comment="PamoFi site: radius site01"] src-address] != 10.77.254.2 || [/radius get [find where comment="PamoFi site: radius site01"] require-message-auth] != "yes-for-request-resp") do={ :error "RADIUS endpoints or protection differ" }
:if ([:tostr [/radius get [find where comment="PamoFi site: radius site01"] service]] != "hotspot" || [/radius get [find where comment="PamoFi site: radius site01"] authentication-port] != 1812 || [/radius get [find where comment="PamoFi site: radius site01"] accounting-port] != 1813) do={ :error "RADIUS service or ports differ" }
:if ([:len [/ip hotspot user find where name!="default-trial"]] != 0) do={ :error "Review local HotSpot users" }
:if ([:len [/ip hotspot walled-garden find]] != 0 || [:len [/ip hotspot walled-garden ip find]] != 0) do={ :error "Review existing walled-garden entries before this isolated test" }
:if ([/ip dns get allow-remote-requests] != true) do={ :error "Router DNS is not available to pilot clients" }
:if ([:len [/ip firewall filter find where comment~"PasoFi test:"]] != 0 || [:len [/ipv6 firewall filter find where comment~"PasoFi test:"]] != 0) do={ :error "Prior PasoFi test rules exist; inspect before retrying" }
:if ([:len [/ip firewall filter find where comment~"PamoFi pilot:" and action=drop]] != 4 || [:len [/ipv6 firewall filter find where comment~"PamoFi pilot:" and action=drop]] != 4) do={ :error "Existing pilot isolation differs" }
# Insert new isolation rules before all existing rules, including FastTrack.
/ip firewall filter add chain=input action=drop in-interface="pfi-pilot-br" comment="PasoFi test: deny input" place-before=([/ip firewall filter find where chain=input]->0)
/ip firewall filter add chain=output action=drop out-interface="pfi-pilot-br" comment="PasoFi test: deny output" place-before=([/ip firewall filter find where chain=output]->0)
/ip firewall filter add chain=forward action=drop in-interface="pfi-pilot-br" comment="PasoFi test: deny forward in" place-before=([/ip firewall filter find where chain=forward]->0)
/ip firewall filter add chain=forward action=drop out-interface="pfi-pilot-br" comment="PasoFi test: deny forward out" place-before=([/ip firewall filter find where chain=forward]->0)
/ipv6 firewall filter add chain=input action=drop in-interface="pfi-pilot-br" comment="PasoFi test: deny input" place-before=([/ipv6 firewall filter find where chain=input]->0)
/ipv6 firewall filter add chain=output action=drop out-interface="pfi-pilot-br" comment="PasoFi test: deny output" place-before=([/ipv6 firewall filter find where chain=output]->0)
/ipv6 firewall filter add chain=forward action=drop in-interface="pfi-pilot-br" comment="PasoFi test: deny forward in" place-before=([/ipv6 firewall filter find where chain=forward]->0)
/ipv6 firewall filter add chain=forward action=drop out-interface="pfi-pilot-br" comment="PasoFi test: deny forward out" place-before=([/ipv6 firewall filter find where chain=forward]->0)
# Only DHCP, the HotSpot DNS servlet and its local login servlets are exposed.
/ip firewall filter add chain=input action=accept in-interface="pfi-pilot-br" protocol=udp src-port=68 dst-port=67 comment="PasoFi test: DHCP request" place-before=([/ip firewall filter find where chain=input]->0)
/ip firewall filter add chain=input action=accept in-interface="pfi-pilot-br" src-address=10.77.10.0/24 dst-address=10.77.10.1 protocol=udp dst-port=64872 comment="PasoFi test: DNS UDP" place-before=([/ip firewall filter find where chain=input]->0)
/ip firewall filter add chain=input action=accept in-interface="pfi-pilot-br" src-address=10.77.10.0/24 dst-address=10.77.10.1 protocol=tcp dst-port=64872 comment="PasoFi test: DNS TCP" place-before=([/ip firewall filter find where chain=input]->0)
/ip firewall filter add chain=input action=accept in-interface="pfi-pilot-br" src-address=10.77.10.0/24 dst-address=10.77.10.1 protocol=tcp dst-port=64873,64875 comment="PasoFi test: local login" place-before=([/ip firewall filter find where chain=input]->0)
/ip firewall filter add chain=output action=accept out-interface="pfi-pilot-br" protocol=udp src-port=67 dst-port=68 comment="PasoFi test: DHCP reply" place-before=([/ip firewall filter find where chain=output]->0)
/ip firewall filter add chain=output action=accept out-interface="pfi-pilot-br" dst-address=10.77.10.0/24 connection-state=established,related comment="PasoFi test: local replies" place-before=([/ip firewall filter find where chain=output]->0)
# Activate the isolated pilot last. Keep Safe Mode open while testing.
/interface wireless set [find where name="pfi-pilot-wifi"] ssid="PasoFi Pilot"
/interface bridge enable [find where name="pfi-pilot-br"]
/radius enable [find where comment="PamoFi site: radius site01"]
/ip hotspot enable [find where name="pfi-pilot-hotspot"]
/ip dhcp-server enable [find where name="pfi-pilot-dhcp"]
/interface wireless enable [find where name="pfi-pilot-wifi"]
:put "PasoFi Pilot is an isolated test only: guest internet and sales are blocked."
:put "Keep Safe Mode open while testing. Press Ctrl+D to undo the test afterward."
}
