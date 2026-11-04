{
# Temporary pilot only: permit RouterOS captive HTTP detection.
# Import in the same Safe Mode session that started the isolated pilot.
:if ([:len [/interface wireguard find where name="pamofi-service"]] != 1 || [/interface wireguard get [find where name="pamofi-service"] public-key] != "AMJXVTVrpj0512Eoj5A6DWNAnjySBPF3VmzODGeN/FE=") do={ :error "Wrong router" }
:if ([:len [/ip hotspot walled-garden find]] != 0 || [:len [/ip hotspot walled-garden ip find]] != 0) do={ :error "Review walled-garden entries before enabling the captive proxy" }
:if ([:len [/ip firewall filter find where comment="PasoFi test: deny forward in" and chain=forward and action=drop and in-interface="pfi-pilot-br"]] != 1 || [:len [/ip firewall filter find where comment="PasoFi test: deny forward out" and chain=forward and action=drop and out-interface="pfi-pilot-br"]] != 1) do={ :error "Expected IPv4 pilot forwarding isolation missing" }
:if ([:len [/ipv6 firewall filter find where comment="PasoFi test: deny forward in" and chain=forward and action=drop and in-interface="pfi-pilot-br"]] != 1 || [:len [/ipv6 firewall filter find where comment="PasoFi test: deny forward out" and chain=forward and action=drop and out-interface="pfi-pilot-br"]] != 1) do={ :error "Expected IPv6 pilot forwarding isolation missing" }
:foreach pfiRule in=[/ip firewall filter find where comment~"^PasoFi test: deny forward"] do={ :if ([/ip firewall filter get $pfiRule disabled] = true) do={ :error "IPv4 forwarding isolation disabled" } }
:foreach pfiRule in=[/ipv6 firewall filter find where comment~"^PasoFi test: deny forward"] do={ :if ([/ipv6 firewall filter get $pfiRule disabled] = true) do={ :error "IPv6 forwarding isolation disabled" } }
:if ([:len [/ip firewall filter find where comment="PasoFi test: local login" and chain=input and action=accept and in-interface="pfi-pilot-br"]] != 1) do={ :error "Expected local login rule missing" }
:local pfiRule ([/ip firewall filter find where comment="PasoFi test: local login"]->0)
:if ([/ip firewall filter get $pfiRule disabled] = true || [:tostr [/ip firewall filter get $pfiRule protocol]] != "tcp" || [:tostr [/ip firewall filter get $pfiRule dst-port]] != "64873,64875" || [/ip firewall filter get $pfiRule src-address] != 10.77.10.0/24 || [/ip firewall filter get $pfiRule dst-address] != 10.77.10.1/32) do={ :error "Local login rule differs" }
/ip firewall filter set $pfiRule dst-port=64873,64874,64875
:put "Captive HTTP detection is allowed for the isolated PasoFi pilot. Forwarding remains blocked."
:put "Keep Safe Mode open; use Ctrl+D to roll back the entire temporary pilot after testing."
}
