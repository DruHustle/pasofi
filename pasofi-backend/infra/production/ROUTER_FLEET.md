# One Pasofi administrator login for your routers

The **Staff → Admin → Routers** workspace lists the registered Pasofi routers across sites. An approved administrator signs in once, completes the existing MFA step, selects a router, reads its managed settings, previews a change, and applies that saved change. Agent and support accounts cannot use this workspace.

The network service reaches each router through its reviewed private management route. Routers do not need to share a customer LAN, and their local administrator passwords are not copied between devices or delivered to the browser. This feature is central Pasofi administration; it does not make a local RouterOS login a universal password or embed WinBox.

The implemented device adapter manages **MikroTik RouterOS hotspot gateways**. A Mercusys MR20 used as a downstream access point keeps its separate manufacturer administration interface; its Wi-Fi configuration is not changed through this RouterOS adapter. See [MR20 commissioning](../../pasofi-routeros/MERCUSYS_MR20.md). The gateway can still enforce the Pasofi customer service behind that access point.

## What the first release can change

Every target must first be listed in a protected server-side registry. The application cannot select an arbitrary RouterOS command or menu.

| Managed target | Editable fields | Enrollment detail |
| --- | --- | --- |
| System identity | Router name | One `identity` target |
| Interface | Comment | Exact existing interface name; addressing and interface name are not edited |
| Legacy wireless | SSID and disabled state | Exact customer radio name, kind `wireless` |
| Modern Wi-Fi | `configuration.ssid` and disabled state | Exact customer radio name, kind `wifi` |
| HotSpot user profile | Rate limit, idle timeout, keepalive timeout | Exact existing customer profile name |

Firewall, NAT, routes, WireGuard, users, keys, passwords, firmware, reboot and reset operations are outside this contract. Enrollment should include customer resources that are safe to manage remotely. Do not enroll the radio or interface on which the only management/recovery connection depends. The application does not automatically discover and approve all interfaces.

SSID or radio-state changes can disconnect customers. Profile limits may interact with RADIUS-provided limits; verify the intended effective behavior on the selected router and a real test session. Do not infer end-to-end enforcement from a successful configuration readback.

## 1. Deploy the qualified application release first

Use the Mac package's `release-deploy.command` and `MAC_DEPLOY.md` to upgrade the existing Oracle installation. The release adds the network service's `005_router_fleet.sql` migration, runtime grants, public facade, private gateway route and web workspace. Reads and writes are disabled unless the optional overlay and its explicit switches are installed.

The ordinary release launcher preserves the currently running Compose configuration and rejects unexplained configuration drift. **Do not add fleet flags to an existing active environment file before running that upgrade.** Install the optional overlay as a separate reviewed configuration change after the application rollout. On subsequent upgrades, the launcher discovers and preserves that installed overlay.

## 2. Qualify each router and its private route

Use the existing management tunnel and a RouterOS 7 version with the HTTPS REST API and the required Wi-Fi menu. For each device, independently verify:

1. The lowercase NAS UUID registered in `radius_nas`, its intended site, and the serial number physically or through the already trusted local management session.
2. Its private management address and the source address the router will see after host NAT. The runtime accepts private IPv4 destinations; a DNS name must resolve only to an allowed private address.
3. A current certificate whose hostname or IP SAN matches the management URL. Export only the public trust certificate to the server; keep the router and CA private keys outside this package and its CA mount.
4. A **dedicated per-device fleet service account**, separate from the existing disconnect reconciler account. Restrict access to the approved management source. Grant only the RouterOS REST/API/read permissions required by the installed version; grant write permission only when qualifying writes. Avoid full administrator, policy, sensitive-data, password-management, reboot, SSH and other unnecessary permissions. RouterOS account write privileges are broader than this application's field allowlist; protect the account and private route accordingly.
5. The exact existing names of the intended guest radios, interfaces and HotSpot user profiles. Use only targets the selected hardware/package actually supports.

The runtime uses verified TLS, refuses redirects, checks the expected device serial before configuration operations, and bounds response size and operation time. No public RouterOS management port is needed. Keep the existing site-link firewall restrictions to the selected private tunnel endpoints and TCP443; the Compose overlay adds outbound connectivity, not authorization to a new device.

Primary reference: [MikroTik REST API](https://manual.mikrotik.com/docs/developer-guides/rest-api/). The application uses object updates for named records and the explicit identity setter for the singleton identity menu. It does not expose a general console wrapper.

## 3. Prepare the protected registry on Oracle

Create an operator-owned directory outside the checkout, for example the operator-selected `/srv/pamofi/router-fleet`, with mode `0700`. Set `PAMOFI_ROUTER_FLEET_DIR` to that verified absolute server path. Prepare:

| Server path inside that directory | Mode | Contents |
| --- | --- | --- |
| `routers.json` | `0444` | Private registry; mounted individually only into the network container |
| `ca/` | `0755` or `0555` | Directory containing only referenced public certificates |
| `ca/<nas-uuid>.pem` | `0444` | One current public trust certificate per device |

The `0700` parent protects host access to the credential file. Its individually mounted `0444` mode lets the non-root container read it without depending on matching host/container user IDs. Never put private keys in `ca/`.

Use `router-fleet.example.json` as a field reference, replacing every placeholder privately. Start with one known router, `allowWrites: false`, and its `identity` target only. The relevant row shape is:

```json
{
  "nasId": "EXACT_REGISTERED_NAS_UUID",
  "url": "https://REVIEWED_PRIVATE_ROUTER_HOST/rest/",
  "username": "DEDICATED_PER_DEVICE_FLEET_ACCOUNT",
  "password": "SET_PRIVATELY_ON_THE_SERVER",
  "caFile": "/run/pamofi/router-fleet-ca/EXACT_REGISTERED_NAS_UUID.pem",
  "expectedSerial": "INDEPENDENTLY_VERIFIED_SERIAL",
  "allowWrites": false,
  "targets": [{"key": "identity", "kind": "identity"}]
}
```

The file contains an array of 1–100 rows. Each router can have 1–16 distinct managed targets. Every non-identity target includes its exact existing `name`. Router UUIDs, serial numbers and management URLs must be unique across the fleet: enroll each physical router once, even if it serves several customer areas. Target keys and resource pairs must be unique within a router. Use `wireless` or `wifi` according to the installed RouterOS package; they are not interchangeable. Do not paste this registry or its credentials into chat, tickets, frontend variables or source control.

Create a new private environment file from `router-fleet.example.env`, with both gates initially `false`. All three inputs are mandatory:

```sh
PAMOFI_ROUTER_FLEET_ENABLED=false
PAMOFI_ROUTER_FLEET_WRITE_ENABLED=false
PAMOFI_ROUTER_FLEET_DIR=/your/verified/private/router-fleet
```

Run the offline material check on Oracle from the qualified source checkout, using those same values in the environment:

```sh
export PAMOFI_ROUTER_FLEET_DIR='/your/verified/private/router-fleet'
export PAMOFI_ROUTER_FLEET_ENABLED=false
export PAMOFI_ROUTER_FLEET_WRITE_ENABLED=false
node pasofi-backend/infra/production/preflight-router-fleet.mjs
```

This returns `prepared-only` without printing passwords, accounts, router addresses or serial numbers. It validates the file contract and public trust material. It does not claim that a router is reachable, the account works, or the hardware matches. Node is needed on the server for this optional standalone check; the Mac itself still needs only the deployment launcher's prerequisites.

## 4. Add the overlay while retaining the complete live configuration

The new file is `pasofi-backend/infra/production/router-fleet.compose.yaml` in the qualified deployed source. Use the **same project name, project directory, every existing ordered `--env-file`, every existing ordered `-f`, and the most recent release's `upgrade.compose.json`** from the running application's Compose labels/private release record. Append the new fleet environment file and the new fleet overlay. Keep the base, Vercel, RADIUS, backup, captive portal, remote access and any other installed overlays in their original order.

The Docker host is Linux even when you connect from a Mac. Run these operations inside the trusted `ssh YOUR_SSH_ALIAS` session. First render the full existing-plus-fleet Compose configuration privately and compare it with the current configuration. The intentional differences are the fleet flags on prepaid/network, a private registry secret and read-only public CA mount on network, and its existing/reviewed outbound management bridge. No provider or customer launch gate, database volume, RADIUS service, published port, or unrelated mount should change. Do not print resolved secret configuration into a shared terminal log.

Use `docker compose` with that complete reviewed argument list for `config --quiet`, then `up -d --no-deps --no-build --pull never --wait prepaid-access network`. These are subcommands to append to the complete installation-specific invocation; a two-file base-plus-fleet command is not a valid substitute for an existing deployment. Application images must remain the qualified release's immutable images. The already deployed web/internal gateways contain the new routes.

Record the new ordered configuration invocation and environment-file paths. Keep both fleet gates `false` until the registry and private route have passed their checks. Then change only the new fleet env file's read gate to `true` and reapply those two services with that same complete invocation. The browser should report `routerFleet: true` and `routerFleetWrite: false` from `/api/capabilities`.

If more than one router is enrolled, verify each one in read-only mode before granting write access. All registered routers are listed; an unconfigured device is labeled as such and cannot be inspected or edited. Customer network access can remain paused throughout commissioning.

## 5. Qualify one controlled write

Choose an enrolled test router with an independent local recovery path. Enable the dedicated account's required write privilege, set only that row's `allowWrites` to `true`, and set the new env file's `PAMOFI_ROUTER_FLEET_WRITE_ENABLED=true`. Run the material preflight with the same final gate values, then recreate the network/prepaid containers using the complete reviewed invocation. Recreating network also ensures a replacement individually bind-mounted registry file is mounted; an atomic host-file replacement alone does not update an existing file bind mount.

Sign in as the approved administrator and complete MFA. Open **Admin → Routers**, select the verified device, choose **Router name**, enter a small reversible test label and a reason, then create a preview. Review the device/site and exact before/after values. **Apply** acts on the saved change ID, not an editable payload. The server verifies the original administrator, authorization version, device serial, policy, expiry and fresh revision before writing.

Only one change can be applying or uncertain on a router at a time. Every preview and state transition has durable history and append-only events. Previews expire after ten minutes. Concurrent edits, a changed target/policy, or a new device at the same address require a new review.

## 6. Handle uncertain outcomes and rollback

| Recorded state | Meaning and next action |
| --- | --- |
| `prepared` | Saved preview. Review and apply before expiry, or create a new preview. |
| `applying` | The write may be in progress. Do not create another attempt. |
| `applied` | Fresh readback matched the saved desired values. Verify effective customer behavior where relevant. |
| `uncertain` | A timeout or interruption prevented a definitive result. Keep the router locked for new writes and use reconciliation. |
| `unchanged` | After the required settlement period, observed values still matched the saved starting values. Review before making a new change. |
| `diverged` | Current values match neither saved state. Inspect the device and prepare a fresh reviewed change. |
| `expired` or `failed` | This saved change cannot proceed. Read its reason and prepare a new preview when the underlying issue is resolved. |

A browser or Vercel request can time out before the router command finishes. The change remains durable; refresh its status instead of resubmitting the write. Reconciliation performs reads only and remains available when global or per-device writes are disabled. The API enforces a conservative `reconcileAfter` time of about 90 seconds from the attempt start because RouterOS commands can outlive a disconnected HTTP client. It will not clear a potentially late write based on an immediate unchanged read.

This recovery contract relies on the [documented RouterOS REST execution rules](https://manual.mikrotik.com/docs/developer-guides/rest-api/): abandoned commands end at the 60-second server limit, and requests for the same dedicated user execute serially. The application restricts the latest write start within its settlement window and never allows background `/execute` jobs. Qualification must confirm that behavior on the installed RouterOS version and that calls go directly to the enrolled router, with no intermediary that queues or retries writes. A generic API emulator or alternative controller with unbounded delayed execution does not meet this contract. A changed account/policy or a router unable to give a trusted fresh read requires local inspection before further changes.

For an applied change, **Prepare rollback** creates a new inverse preview only while the device still matches the saved after-state. Review and apply that new preview. It is a guarded new write with its own reason and audit trail. If connectivity is lost or another operator has changed the device, restore the connection or inspect locally; the UI cannot promise an automatic out-of-band recovery.

## Acceptance record

Record the release SHA, NAS UUID, serial, account-policy verification, certificate and tunnel checks, successful read, reviewed apply, observed effective behavior, reviewed rollback and audit history for each qualified device. Also prove that agent/support accounts and a request from another origin cannot change configuration. Test a lost-response/reconnect scenario in a maintenance window and confirm it reconciles without duplicate writes.

This release's software tests use disposable HTTPS RouterOS fixtures and isolated databases. The prepared Mac ZIP, passing tests and registry validation do not mean that Oracle or physical routers have already been configured. Customer sales, payment providers and customer network access retain their existing independent gates.
