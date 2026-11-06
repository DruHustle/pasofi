# Check PasoFi remote access from a Mac

`Check_PasoFi_Remote.command` checks the **explicit devices in a private owner-management manifest**. It helps establish whether your Mac can reach their management ports through the intended Tailscale hub. Use the normal WebFig, WinBox, Tenda or Mercusys interface to sign in, troubleshoot and manage firmware.

This is separate from `Start_PasoFi.command`. It does not deploy PasoFi, contact the Onesa SSH aliases, install or configure a VPN, change a router, or perform upgrades. The site tunnel, hub, approved routes and owner access policy must already be in place. The [network planner](../network/README.md) prepares those changes for review; it does not make them live.

## Run it

1. Use macOS 13 or newer with Python 3.9 or newer and one installed official Tailscale Mac app. Existing App Store and standalone apps are supported; do not install both. Open Tailscale and complete its usual owner login and macOS VPN permissions. The exact approved login must match the private manifest.
2. Put the planner's private `owner-targets.json` beside this launcher, keeping the file's private permissions. Its device addresses, physical identities and hub identity must come from verified inventory. The checker accepts an owner-owned regular file with permissions `600` and refuses symbolic links.
3. Double-click `Check_PasoFi_Remote.command`. A new private `PasoFi_Remote_Check_…` folder appears beside the manifest. Open `remote-check.html` for the result; `remote-check.json` contains the structured observations.

To use a manifest elsewhere, run:

```sh
./Check_PasoFi_Remote.command "/path/to/owner-targets.json"
```

For an actual test from another network, unplug Ethernet and connect your Mac to a different site's Wi-Fi or a mobile hotspot. Record that assertion explicitly:

```sh
./Check_PasoFi_Remote.command "/path/to/owner-targets.json" --different-wifi
```

The checker observes the active network interfaces and default route. **Wi-Fi with no Ethernet does not prove you are outside the PasoFi site.** `--different-wifi` is recorded as your report, not independent location verification.

Optional actions are explicit:

```sh
# Open only the existing signed Tailscale app. No install, login or checks.
./Check_PasoFi_Remote.command --open-tailscale

# Check the manifest, then open one named target's normal web interface.
./Check_PasoFi_Remote.command "/path/to/owner-targets.json" --open-target gateway-a
```

The example target ID is illustrative; use an ID in your actual manifest. Opening a target requires fresh route/account checks and a usable response on its selected web port. Redirects, certificate failures and missing/error responses prevent automatic browser opening. The report records the issue for manual review. For an approved WinBox port, open the native Mac WinBox app and enter the listed IP address. Layer-2 neighbour discovery is not part of this routed VPN check.

`--output "/existing/directory"` chooses the parent directory for a new private report folder. Existing reports are not overwritten. No browser or report opens automatically unless an explicit opening option was supplied.

## What the result means

| Result | Meaning |
| --- | --- |
| `transport-checked-identity-pending` | Every listed TCP port accepted a connection through the correlated VPN interface, with stable account/network observations across the run. Review the separate HTTP/TLS results. |
| `incomplete` | At least one route, account, local-network, time-budget or connection check failed or could not be established. Unchecked devices remain unchecked. |
| Device identity: pending | The listed serial/MAC is the expected inventory value. This tool has not authenticated to the device to confirm it. |
| Different Wi-Fi: operator-reported | You supplied `--different-wifi`; the computer has not independently established an off-site location. |

The JSON always retains `qualification.qualified: false`. A successful port check, login page or TLS certificate does not establish that the intended physical device was reached. Sign in through the normal management UI and compare each device's serial or management MAC against the report before making changes. An upstream gateway response does not qualify its downstream routers or either CPE; every device has a separate row.

Complete qualification also needs authenticated device checks, an unauthorized-access denial test, and reconnect checks after sleep/network changes. Those are explicitly pending. This tool does not test customer service, payments, Hotspot access or firmware recovery. It collects no router passwords, login cookies or client private keys.

Exit codes: `0` means the listed TCP checks completed successfully; it does **not** mean complete remote qualification. `3` means a private report was produced with incomplete checks. `2` means an input, local file, unsupported environment or explicit UI-opening action was refused.

## Scope and safeguards

- The input is the network planner's schema v1 `pasofi-owner-management` / `prepared-only` manifest. It names one exact Tailscale login, an observed stable hub node ID, and unique private IPv4 targets with explicit TCP ports drawn from `22`, `80`, `443` and `8291`. `requiredRoutes` must exactly match the ordered target `/32` list. Names, IDs, timestamps and distinct serial/MAC expectations are validated. The manifest's preparation status is not proof of a live route.
- The current Tailscale login, owner online state, exact hub stable ID and hub primary-route ownership must match. `Online` is control-plane presence, not a transport test. The checker does not trust an arbitrary interface merely because its name starts with `utun`.
- The selected `utun` must actually carry the current Tailscale source IP. Each target's current macOS route must use that same interface, and the expected hub must uniquely own its exact primary `/32` route. An overlapping active local or other-VPN network blocks that target even if its VPN host route currently wins. Missing or ambiguous CLI/route data fails before probes.
- Before each connection, the route is checked again. The TCP socket is bound to both the verified interface and its source address, with no unbound retry. The account, interface and network observations are checked again at the end; changes invalidate the overall result.
- Only the listed TCP ports are contacted, once each. Ports 22 and 8291 receive no application payload; no SSH session is created. The manifest's ICMP policy is retained by the planner but the Mac checker never pings or scans.
- Web checks send a single credential-free `GET /` to the listed IP on port 80 or 443. They use no proxy, browser cookies, authentication or redirects. HTTPS uses certificate validation without an insecure retry. Only the status code, authentication-challenge presence and redirect classification are retained, never response bodies, header values, cookies or redirect destinations.
- Network probes share a two-minute run budget; each connection has a four-second budget and each web header is capped at 16 KiB. Local read-only commands are time/output bounded. A large target list may exceed the run budget, in which case remaining targets are explicitly untested.
- Local commands run with a minimal environment; Tailscale is forced into CLI mode. The official app's Apple code signature and Tailscale team identity are verified before its CLI is used. The two GUI variants in `/Applications` or the owner's `~/Applications` are supported. A CLI-only/custom installation or multiple app copies needs separate qualification and is not executed as a fallback.
- Reports use a new mode-`700` directory and mode-`600` JSON/HTML files. HTML contains no executable script or external resources. Raw Tailscale status, unrelated peer inventory, auth URLs, raw HTTP and command stderr are not saved.

The optional `--open-target` action hands control to a normal browser after fresh checks. Future browser requests are outside this checker's bound-socket transport; keep the VPN connected and confirm the target's identity in its UI. For redirects or untrusted certificates, inspect the normal UI destination deliberately rather than treating a TCP response as approval to proceed.

## Local verification

From the repository root:

```sh
python3 -B -m unittest discover -s pasofi-backend/infra/remote-access/operator-mac -p 'test_*.py' -v
/bin/bash -n pasofi-backend/infra/remote-access/operator-mac/Check_PasoFi_Remote.command
```

The tests use synthetic manifests, mocked status/routes/sockets and temporary private files. No test connects to a router, hub or service. On macOS, one additional native test sets and reads the interface-bound socket option on `lo0` without connecting or listening. This tests the local socket API, not an operational Tailscale tunnel. Real GUI-client routing, owner login and off-LAN physical-device checks remain live qualification work.

## Primary references

- [Tailscale Mac installation](https://tailscale.com/docs/install/mac) and [Mac variants](https://tailscale.com/docs/concepts/macos-variants): supported OS, initial login/permission flow, and avoiding duplicate variants.
- [Tailscale CLI on macOS](https://tailscale.com/docs/reference/tailscale-cli?tab=macos): app-bundled CLI and `TAILSCALE_BE_CLI=1`. JSON status is a documented interface whose format can change; unknown formats fail closed.
- [Tailscale status source](https://github.com/tailscale/tailscale/blob/main/ipn/ipnstate/ipnstate.go): `Self`, `User`, stable peer `ID`, `Online` and `PrimaryRoutes` semantics.
- [Tailscale macOS management documentation](https://tailscale.com/docs/integrations/mdm/mac): GUI bundle identifiers and signing team `W5364U7YZB`. This checker does not install a management profile.
- [Apple's Darwin socket header](https://github.com/apple/darwin-xnu/blob/main/bsd/netinet/in.h): public `IP_BOUND_IF` option.
- [Native Mac WinBox](https://mikrotik.com/download/winbox): the normal MikroTik administration client.
