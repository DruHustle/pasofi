# Disabled pilot isolation scaffold

**Review required:** A RouterOS 7.25.1 import encountered a bridge-port
conflict and left an inactive pilot-tagged port referring to missing interface
IDs after rollback. The revised plan refuses any prior pilot-tagged port and
checks the new radio's bridge membership before and after adding its port.
Validate cleanup, syntax and live behavior on the selected router in Safe Mode
before considering the scaffold qualified.

This review-only plan targets the inspected hAP lite with an existing active
`wlan1`. It creates a new disabled bridge, inserts IPv4 and IPv6 input, output
and forwarding drops before existing rules, and attaches a disabled virtual AP
with client-to-client forwarding off. It does not change the existing Wi-Fi,
IP addressing, DHCP, NAT, RADIUS or HotSpot. The open radio profile is not
active: both new interfaces remain disabled. A separate reviewed plan must
qualify HTTPS, authentication, DHCP, isolation and accounting before enabling
the radio or allowing any customer traffic.

The separate `network-plan.mjs` prepares a fixed `10.77.10.0/24` first-site
pilot address, pool, DHCP network and a disabled DHCP server, while requiring
the existing bridge and radio to remain disabled and retaining the deny rules.
It does not add a DNS override, NAT, HotSpot or RADIUS. Reinspect all current
routes and address pools for overlaps before using this fixed subnet; its
preflight checks the exact route and names, not every possible wider overlap.
Check the review file with RouterOS dry-run and use Safe Mode for any import.
On RouterOS 7.25.1, an inactive rule can have interface-not-ready messages
prepended to its comment while the bridge is disabled. A `find where
disabled=no` filter also omitted the observed inactive rules even though they
were not marked disabled. The guard checks match the expected comment suffix
and independently require the intended chain, interface, drop action and exact
counts, then read each matched rule's disabled property directly. The import prints
the bridge, radio, DHCP and gateway readbacks; validate them in Safe Mode.

```sh
node --test pamofi-backend/infra/pilot-isolation/network-plan.test.mjs
node pamofi-backend/infra/pilot-isolation/network-plan.mjs /private/tmp/pamofi-pilot-network.rsc
```

The separate `hotspot-plan.mjs` prepares a disabled first-router HotSpot
profile using HTTPS login, the fingerprint-pinned imported certificate and
RADIUS accounting. It requires the site RADIUS client, pilot bridge, radio and
DHCP server to stay disabled and refuses ordinary local HotSpot users. It allows
only the built-in `default-trial` record, while setting `login-by=https` without
trial login. RouterOS
can automatically add a **router-wide static DNS entry** for the configured
HotSpot hostname; inspect existing DNS state and the resulting entry. The plan
does not make DNS, DHCP, forwarding, NAT or a walled garden available to guests,
enable the RADIUS client or server, or qualify authentication and accounting.
Dry-run the generated file and use Safe Mode before applying it.
RouterOS 7.25.1 rejected `https-redirect` during dry-run, so the plan does not
set it; actual HTTPS interception and captive-client behavior remain unverified.

```sh
node --test pamofi-backend/infra/pilot-isolation/hotspot-plan.test.mjs
node pamofi-backend/infra/pilot-isolation/hotspot-plan.mjs /private/tmp/pamofi-pilot-https.rsc
```

Run `node --test pamofi-backend/infra/pilot-isolation/plan.test.mjs` and prepare
a new review file with `node pamofi-backend/infra/pilot-isolation/plan.mjs
/private/tmp/pamofi-pilot-isolation.rsc`. Inspect and checksum the file, retain
independent local recovery, upload it and use RouterOS `verbose=yes dry-run`.
Live import requires a fresh Safe Mode session and readback; a syntax check
alone does not verify behavior. Do not enable the bridge or radio as a shortcut
to service activation.
