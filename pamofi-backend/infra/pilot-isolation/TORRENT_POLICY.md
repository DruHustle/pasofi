# Guest torrent-port restriction

The owner requested torrent restrictions for both sites. The reviewed plan
adds two IPv4 forward drops for TCP and UDP destination ports 6881–6999 and
51413, scoped to the `pfi-pilot-br` guest bridge and inserted before existing
forward rules. The plan requires the guest bridge and radio to be disabled and
the IPv4/IPv6 guest isolation drops to exist before importing. It does not
enable a hotspot or affect the existing management bridge. IPv6 guest
forwarding must remain denied unless a separate IPv6 policy is qualified.

This is **best effort**, not a complete BitTorrent or movie-download block.
Torrent applications can use other ports, encryption, VPNs or proxies. Other
applications using these ports will also be blocked. The rule does not target
ordinary HTTPS video streaming. Test common-port denial, allowed web use,
existing management access, FastTrack ordering and device performance on each
physical router before marking the policy active.

Avoid generic layer-7 content inspection on this 32 MiB router: MikroTik
describes it as resource intensive and unsuitable for broad web blocking.
Its TLS hostname matcher also cannot match every fragmented handshake. See
[RouterOS Layer7](https://help.mikrotik.com/docs/spaces/ROS/pages/130220161/Layer7)
and [firewall matchers](https://help.mikrotik.com/docs/spaces/ROS/pages/250708064/Common%2BFirewall%2BMatchers%2Band%2BActions).

```sh
node --test pamofi-backend/infra/pilot-isolation/torrent-plan.test.mjs
node pamofi-backend/infra/pilot-isolation/torrent-plan.mjs /private/tmp/pamofi-guest-torrent-policy.rsc
```

Review the generated file, check RouterOS syntax and import in Safe Mode with
off-device recovery. The rules can affect non-torrent applications and should
not be represented as a guarantee that all downloads are blocked.
