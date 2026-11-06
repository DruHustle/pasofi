# Remote management

## Owner access to multiple routers and CPEs

Use the [owner network planner](network/README.md) when the owner must connect
from another Wi-Fi/mobile network and administer multiple MikroTik routers
plus individually verified Tenda/Mercusys management pages. It prepares a
dedicated Tailscale-to-WireGuard management path, explicit device `/32` routes,
per-device ports and return-path rules. It preserves the existing backend
service tunnel and requires review of the hub's current policy and routes.

The [separate Mac checker](operator-mac/README.md) checks the expected account,
hub and actual VPN routes before probing only the enrolled targets. It is
read-only and is separate from `Start_PasoFi.command`, which deploys the
application. Neither tool activates remote access or qualifies a device from
a reachable TCP port alone. Authenticated device logins, isolation and
off-site/reconnect acceptance remain live checks.

One owner VPN connection provides network access; each device retains its
native administrator login and maintenance interface. This does not add
firmware upgrades or Tenda/Mercusys adapters to the fleet API.

## Single-router access: direct WireGuard first, hub fallback

The first inspected router is a **SMIPS hAP lite with RouterOS 7.18.2**. It supports native WireGuard. The owner can connect directly from a phone or laptop **without operating a separate public server** when either a reachable public IPv4 path or usable global IPv6 path exists. A local `192.168.0.1` upstream gateway establishes an upstream private network; it does **not** establish carrier-grade NAT or rule out direct access.

The source tools here assess operator-supplied observations and prepare review files only. They do not discover the live network, create keys, contact the router, change firewall rules, enable access or prove a working tunnel. No direct endpoint, public hub or active tunnel has been qualified for this site.

## Choose the path from evidence

| Observed path | Management design | What must be established |
|---|---|---|
| Public IPv4 on the MikroTik | Owner's WireGuard app connects directly to the router UDP endpoint | Address belongs to this connection; ISP and firewall permit the chosen UDP port; an off-LAN handshake succeeds |
| Public IPv4 on an upstream router | Same direct connection, with upstream UDP forwarding to the MikroTik | Control of every intervening NAT/firewall; stable MikroTik uplink address; only the chosen UDP port forwarded |
| Routed global IPv6 on the MikroTik | Owner's WireGuard app connects to the router's global IPv6 endpoint | IPv6 on the actual remote network and allowed inbound UDP through all upstream IPv6 firewalls |
| No usable direct path; supported always-on device at site | Qualify a local Tailscale subnet router with a router-only management route | Device/OS support, power, routes, owner policy and reconnect tests |
| No usable direct path and no site helper | Router initiates WireGuard to a selected public Linux hub; owner connects through Tailscale on that hub | Authenticated hub, host firewall, tailnet identity/policy, route approval and recovery |

The owner has reported **no always-on site helper**. SMIPS hAP lite cannot run a normal Tailscale client or MikroTik Back To Home. Back To Home uses MikroTik-managed relays when direct connectivity is unavailable, but its published architecture requirement is ARM, ARM64 or TILE, with RouterOS 7.12 or later. It is an option for compatible hardware, not a feature to enable on this hAP lite.

A dynamic-DNS hostname follows an address change; it does not create inbound reachability or bypass carrier-grade NAT. A DNS name must resolve to the selected public address family. Mixed A/AAAA records can send a client to an unreachable family. Check the real client behavior and re-test after an ISP address/prefix change.

**Scope:** this is owner access to the router. It does not replace PamoFi's backend, databases, payment processing, private RADIUS path or separately scoped service credentials. A successful phone-to-router VPN does not demonstrate that the backend can reach the NAS or that paid hotspot service is deployed.

## Assess the observations without inventing a result

Copy [observations.example.json](observations.example.json) outside Git and record only observed values:

```sh
node pasofi-backend/infra/remote-access/assess.mjs /private/observations.json
```

The example intentionally leaves endpoint addresses, forwarding, IPv6 availability and UDP reachability unknown. The earlier inspection established connected networks and the upstream gateway, not the upstream public WAN address or an off-LAN handshake.

- `ipv4.routerAddress` is the MikroTik uplink address. `ipv4.upstreamAddress` is the upstream router's **WAN address**, not its LAN gateway. `null` means unknown.
- `ipv4.portForwarding` is `unknown`, `available` or `unavailable`. Availability alone does not prove that a rule exists or works.
- `ipv6.routerAvailability` is `unknown`, `present` or `unavailable`. `present` requires a native global unicast `routerAddress`; otherwise use `null`.
- `ipv6.clientConnectivity` describes the actual remote phone/laptop network: `unknown`, `available` or `unavailable`.
- Each `udpReachability` is `untested`, `blocked` or `reported-working`. Use the last value only after an actual off-LAN WireGuard test. The report labels this **operator-reported**, never independently verified by the tool.

The assessment keeps private/shared IPv4 observations distinct from a confirmed NAT diagnosis, considers IPv6 even when IPv4 is blocked, and recommends inspection while evidence is missing. It suggests a helper/relay fallback only after both current direct paths are reported unavailable. Other RouterOS major versions require separate feature qualification.

## Prepare direct access

Use [direct-plan.example.json](direct-plan.example.json) for IPv4 or [direct-ipv6-plan.example.json](direct-ipv6-plan.example.json) for IPv6. Every placeholder must be replaced; the examples deliberately fail validation before they can produce a plan.

1. Inspect the router and the owner's remote device routes, addresses, other VPNs and firewall. `10.77.255.1` and `.2` are proposed addresses, not allocations. Record their **non-default IPv4 destination networks** in `routerNetworks` and `clientNetworks`. Include connected, private and VPN routes. The generator rejects overlaps, noncanonical networks and `/0`; omit the default Internet route from the inventory. If the owner device genuinely has no such IPv4 networks, for example on an IPv6-only connection, supply an explicitly inspected `clientNetworks: []`; omitted inventory is still rejected. Recheck after changing networks or enabling another VPN.
2. On the owner's phone/laptop, create a WireGuard tunnel and generate its key pair locally. Keep its private key on that device and copy only its public key into the plan. Each additional owner device needs its own separately reviewed peer/key and address; never share a private key across devices.
3. With the exact interface creation approved and local recovery available, create a fresh **disabled** router interface. RouterOS generates and retains its key. For the example port only:

   ```routeros
   /interface wireguard add name=pamofi-management listen-port=51820 disabled=yes
   :put [/interface wireguard get [find where name="pamofi-management"] public-key]
   ```

   Read only the public key and insert it into the plan. Do not export private keys or paste them into chat/Git. If this interface already exists, inspect it instead of creating a duplicate. The generated preflight rejects existing peers, addresses, routes, interface-list/bridge membership and prior tagged configuration. A rejection requires review of the existing state, not removal of safeguards.
4. Select `directRoute`: `public-ipv4`, `upstream-forwarded-ipv4` or `global-ipv6`. Set `wanInterface` to the inspected uplink. `routerEndpoint` accepts a public IPv4 literal, native global IPv6 literal or selected DNS hostname matching the chosen family. Supply IPv6 **without brackets**; the generated client file adds them. DNS is not resolved by this offline tool.
5. `port` is the UDP port on both the public endpoint and the router. For upstream IPv4 forwarding, map that same UDP port to the MikroTik uplink address and reserve its address. No TCP WebFig, WinBox or API port is forwarded. IPv6 normally needs firewall permission on the routed path rather than IPv4 port forwarding.
6. Choose `managementPorts`, a nonempty subset of `80`, `443` and `8291`. These correspond to the standard HTTP WebFig, HTTPS WebFig and WinBox ports. Match the actual existing service configuration. The inspected router's HTTPS service was disabled; selecting `443` does not enable it or provision a certificate. HTTP WebFig on `80` is encrypted inside WireGuard; qualify a trusted HTTPS certificate before changing the preferred service. SSH and API ports are not permitted by this planner.

Then generate a new private review directory:

```sh
node pasofi-backend/infra/remote-access/plan.mjs /private/direct-plan.json /private/pamofi-direct-review
```

Outputs are `router-management.rsc.review`, `client-wireguard.conf.review` and `review.json`. The directory is mode `0700`; files are `0600`; existing paths are never overwritten. Unknown input fields, private-key fields, malformed/noncanonical keys, reserved endpoints, injected commands and network overlaps are rejected before output is created. Public-key formatting cannot establish key ownership; compare against the actual devices.

The client review file contains `REPLACE_ON_OWNER_DEVICE_ONLY`. Copy its public settings into the already-created owner tunnel while preserving that device's private key. Do not import the literal placeholder. The only `AllowedIPs` route is the router management `/32`; there is no default route, DNS change or home/customer subnet route. IPv6 outer transport still carries this same limited IPv4 management path.

## Apply and verify direct access

Before a browser-driven change creates VPN access or a firewall grant, obtain the required action-time confirmation for the concrete reviewed change. Preserve the existing administrator credentials, home LAN, DHCP, wireless and upstream connection. Record an off-device backup and retain an independent local recovery session.

The generated RouterOS commands use one enclosing script block so a preflight error stops the remainder. Apply the reviewed block as a unit, not selected lines. On RouterOS 7.18.2, use the available import verbose/dry-run facility first to catch syntax errors, then apply in Safe Mode. This source test suite is not a RouterOS runtime and does not replace that device-side check.

The script keeps the dedicated interface disabled while it installs protections:

- Input allows only the chosen management TCP ports and ICMP echo request, bound to the dedicated interface, owner's tunnel source `/32` and router tunnel destination `/32`.
- An explicit interface-scoped input drop rejects every other decrypted router request. IPv6 traffic inside the tunnel is rejected.
- Forward drops in **both directions** precede all existing forward accepts and FastTrack rules. This prevents access to customer/home LANs or using the router as an Internet exit.
- Only the chosen **outer UDP transport** is accepted on the inspected uplink and selected IP family. The WireGuard peer's key authenticates the roaming owner device; the peer admits only its assigned inner `/32`.
- The interface is enabled only after the guarded peer, address and `/32` route are configured. No LAN-list membership, NAT, password or service change is added.

Review `review.json` and complete these acceptance checks from mobile data or another genuinely separate network, with local Wi-Fi disabled:

1. A fresh WireGuard handshake appears and the selected management login works at the dedicated tunnel address.
2. Other router ports/addresses, forwarding to LAN clients and an unapproved peer/key are denied. Check UDP transport and public management exposure separately; the existence of a UDP firewall rule does not prove a WireGuard handshake.
3. Original local management and home/client networking still work. A router reboot and changing the owner's network reconnect successfully. Re-test after changing the public address or IPv6 prefix.
4. Record public endpoints, peer public keys, exact reviewed rules, test networks and timestamps without private credentials. Claim active remote access only after these tests pass.

To revoke, disable the dedicated peer/interface first, remove the exact upstream UDP forwarding rule if used, then remove only individually tagged plan entries after confirming local recovery. Do not use a broad firewall reset or clear unrelated connections/routes. If applying a script fails partway, keep the interface disabled and inspect partial tagged state before recovering or retrying.

## Hub fallback with Tailscale

Use [public-plan.example.json](public-plan.example.json) when the observed direct paths cannot be used. Explicit `mode: "hub"` is preferred; legacy input that omits `mode` retains hub behavior. Newly prepared plans should supply `routerNetworks` and `serverNetworks`. Legacy inputs without inventories receive a review warning and still require an independent overlap check before activation.

The MikroTik initiates an outbound WireGuard peer connection to the selected Linux hub with a 25-second keepalive. The server advertises only the router management `/32` to Tailscale. The owner identity receives only the chosen TCP management ports. No site helper is required in this design, but the selected public hub and authenticated tailnet are required.

Inspect the hub's existing interfaces, routes, firewall manager, UDP listeners, advertised routes and service dependencies. Preserve all existing applications and SSH recovery restrictions. Generate the server WireGuard key locally with restricted permissions; the private key stays on the server. Authenticate Tailscale interactively and verify the exact account. Prepare the router interface disabled as above, with a distinct unused local listen port if needed. The hub's `port` field is its **server** UDP endpoint, not a command to change the router listen port.

```sh
node pasofi-backend/infra/remote-access/plan.mjs /private/public-plan.json /private/pamofi-hub-review
```

The hub plan adds `server-wireguard.conf.review`, `tailscale-policy-fragment.json` and `route-command.txt`. Substitute the server private key only on that server. Retain Tailscale's default subnet SNAT so the router sees only the approved hub tunnel source. With the host's existing firewall manager, allow only the chosen TCP traffic from `tailscale0` to the router `/32`, allow established return traffic and deny all other forwarding on this management path. The router guards do not replace the hub firewall or tailnet policy.

`tailscale set --advertise-routes` **replaces** the route list. The generated command is only for a new dedicated hub with no existing advertised routes. Inspect the current setting (`tailscale get advertise-routes` on a current CLI, or the equivalent supported preferences/admin view for the installed version) and explicitly preserve separately approved existing routes on a shared hub. Do not blindly run the one-route command there.

Merge the policy fragment after reviewing the existing tailnet policy: grants are additive, so an existing broad grant can bypass a new narrow intention. Approve only the required management `/32`, preserve unrelated access and test an actual non-owner denial. Windows/macOS/mobile normally accept subnet routes; a Linux owner client needs route acceptance enabled. The generated tailnet grant allows TCP only; it does not grant ICMP even though the router accepts the hub's limited echo request.

Run the same off-LAN allow/deny/reboot checks, plus hub restart/reconnection and Tailscale identity/route-policy checks. To revoke the hub path, disable the exact tailnet route/grant, then disable the dedicated WireGuard peer/interface and remove only its tagged configuration after recovery is confirmed.

## Source verification

```sh
node --test pasofi-backend/infra/remote-access/*.test.mjs
```

Tests cover mode selection and honest unknown states, public IPv4/IPv6 endpoint validation, canonical keys, observed-network overlap, command injection, private/exclusive output, legacy hub behavior, route-list preservation warnings, narrow peer routes and rendered firewall allow/deny order ahead of permissive/FastTrack rules. They do not emulate RouterOS, authenticate a phone or test a live router.

Official references checked 2 November 2026:

- [MikroTik WireGuard](https://manual.mikrotik.com/docs/virtual-private-networks/wireguard/) — road-warrior configuration, public keys, firewall ordering and upstream UDP forwarding. The inspected 7.18.2 configuration deliberately avoids newer client-export parameters and uses an explicit `/32` client configuration.
- [MikroTik Back To Home](https://manual.mikrotik.com/docs/network-management/cloud/back-to-home/) — supported architectures and managed relay behavior.
- [MikroTik scripting](https://help.mikrotik.com/docs/spaces/ROS/pages/47579229/Scripting) — error termination and import dry-run, available from RouterOS 7.16.
- [Tailscale subnet routers](https://tailscale.com/docs/features/subnet-routers) and [Tailscale CLI](https://tailscale.com/docs/reference/tailscale-cli) — subnet SNAT, route acceptance and route preferences.
- [IANA IPv4 special-purpose registry](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml) and [IPv6 special-purpose registry](https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml) — conservative endpoint exclusions. Syntactically global addresses still require ownership and reachability checks.
