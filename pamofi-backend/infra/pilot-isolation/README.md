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

Run `node --test pamofi-backend/infra/pilot-isolation/plan.test.mjs` and prepare
a new review file with `node pamofi-backend/infra/pilot-isolation/plan.mjs
/private/tmp/pamofi-pilot-isolation.rsc`. Inspect and checksum the file, retain
independent local recovery, upload it and use RouterOS `verbose=yes dry-run`.
Live import requires a fresh Safe Mode session and readback; a syntax check
alone does not verify behavior. Do not enable the bridge or radio as a shortcut
to service activation.
