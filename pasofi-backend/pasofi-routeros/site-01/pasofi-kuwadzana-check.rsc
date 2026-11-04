{
# PasoFi Kuwadzana: identify the router, retain isolation and report readiness.
# No credentials are printed. This does not enable Wi-Fi or customer service.
:if ([:len [/interface wireguard find where name="pamofi-service"]] != 1) do={ :error "Expected Kuwadzana service interface not found" }
:if ([/interface wireguard get [find where name="pamofi-service"] public-key] != "AMJXVTVrpj0512Eoj5A6DWNAnjySBPF3VmzODGeN/FE=") do={ :error "This is not the reviewed Kuwadzana router" }
:if ([:len [/interface bridge find where name="pfi-pilot-br"]] != 1 || [:len [/interface wireless find where name="pfi-pilot-wifi"]] != 1) do={ :error "Expected pilot interfaces not found" }
:if ([/interface bridge get [find where name="pfi-pilot-br"] disabled] != true || [/interface wireless get [find where name="pfi-pilot-wifi"] disabled] != true) do={ :error "Pilot bridge and Wi-Fi must be disabled before this check" }
:put ("PasoFi Kuwadzana RouterOS: " . [/system resource get version])
:put ("Free memory bytes: " . [/system resource get free-memory])
:put ("Tunnel disabled: " . [/interface wireguard get [find where name="pamofi-service"] disabled])
:put ("Pilot gateway entries: " . [:len [/ip address find where interface="pfi-pilot-br" and address="10.77.10.1/24"]])
:put ("Pilot DHCP entries: " . [:len [/ip dhcp-server find where name="pfi-pilot-dhcp" and disabled=yes]])
:put ("Pilot HotSpot entries: " . [:len [/ip hotspot find where name="pfi-pilot-hotspot" and disabled=yes]])
:put ("Pilot RADIUS entries: " . [:len [/radius find where comment="PamoFi site: radius site01" and disabled=yes]])
:put ("Pilot IPv4 isolation rules: " . [:len [/ip firewall filter find where comment~"PamoFi pilot:" and action=drop]])
:put ("Pilot IPv6 isolation rules: " . [:len [/ipv6 firewall filter find where comment~"PamoFi pilot:" and action=drop]])
:put ("Router DNS available to clients: " . [/ip dns get allow-remote-requests])
:put ("Pilot Wi-Fi name: " . [/interface wireless get [find where name="pfi-pilot-wifi"] ssid])
:put "Check complete: no settings were changed; prepaid service remains disabled."
}
