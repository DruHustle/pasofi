# Approved devices (captive-portal bypass)

Approved PasoFi administrators manage a list of device MAC addresses at
`https://pasofi.mobile.onesa.eu/admin` (also **Staff → Administration → Approved devices**).
Listed devices, such as IoT equipment and whitelisted phones, get internet at every configured
PasoFi site router without the HotSpot captive portal. Agent and support accounts cannot see or
change the list. Every change requires the existing staff sign-in, MFA, the administrator role and
a written reason.

## How it works

| Layer | Responsibility |
| --- | --- |
| Web `/admin` | Shows the list with label, MAC and per-router state; add and remove with a reason; "Sync routers now". |
| prepaid-access `/v1/admin/approved-devices` | Staff identity, MFA, admin role and origin checks. Signs a 15-second `device-allowlist:read` or `device-allowlist:write` service token with the server-derived actor. |
| network `/internal/v1/device-allowlist` | Validates and stores the desired list (migration `006_device_allowlist.sql`), audits each change, and reconciles every router. |
| RouterOS | One `/ip/hotspot/ip-binding` per device: `type=bypassed`, `server=all`, `mac-address=AA:BB:CC:DD:EE:FF`, comment `pasofi-allowlist:<entry-uuid> <label>`. |

Validation: MAC addresses are normalized to upper-case colon form and broadcast, multicast and
all-zero addresses are rejected. Labels are 1–80 characters, reasons 10–500 characters, and the
list holds at most 200 devices.

Reconciliation runs after each change and on "Sync routers now". For each router in the
router-control registry it reads all ip-bindings, removes **tagged** bindings that are no longer
wanted (or were edited), adds missing ones, then re-reads to confirm. It **never creates, changes or
removes a binding without the exact `pasofi-allowlist:<uuid>` tag**. For example, K0's bypassed
binding for K1's management uplink is never touched. If an untagged binding already covers an
approved MAC, that device is reported as **Existing router rule** on that router and nothing is
written for it. Each router reports **In sync**, **Needs attention**, **Unreachable** or **Not
connected** (no router-control entry). Each device shows **Active**, **Existing router rule**,
**Not applied**, **Waiting for sync** or **Not connected** per router. Routers that cannot be reached
keep their previous bindings and catch up on the next sync.

Audit: `device_allowlist_events` records who added or removed each device, the MAC, label and
reason, plus each binding write the reconciler sent to a router on that administrator's behalf.
Entries are never rewritten; a database trigger allows only a single removal.

## Router prerequisites (owner operation, not performed by this release)

1. **A restricted REST account per router with write access to `/ip/hotspot/ip-binding`.** The
   feature reuses each router's row in the router-control `routers.json` (`nasId`, private
   `https://<tunnel-ip-or-reviewed-host>/rest/` URL, username, password, pinned CA file). RouterOS
   group policies cannot be scoped to a single menu, so that account needs the `read`, `write` and
   `rest-api` policies. Limit it to the Oracle tunnel source address with the RouterOS user
   `address` setting and the service/firewall allowlist. The backend only ever issues
   `GET /rest/ip/hotspot/ip-binding`, `PUT /rest/ip/hotspot/ip-binding` with the fixed bypass shape,
   and `DELETE /rest/ip/hotspot/ip-binding/*ID` for tagged records. The existing session-disconnect
   reconciler uses the same row.
2. **A private service tunnel from the VM to each router.** Today only **G0 (Goromonzi) at
   `10.77.254.2`** is reachable from the VM. **K0 (Kuwadzana) has no private service tunnel to the VM
   yet**, so it appears as Unreachable (or Not connected without a `routers.json` row) until one exists.
3. Each `nasId` must be the router's row in `radius_nas`. Routers without a router-control row are
   listed as Not connected.

## Enabling

Deploy the release first (migration, grants, gateway route, web). Then include the optional overlay
after the router-control overlay:

```bash
docker compose \
  -f pasofi-backend/infra/production/compose.yaml \
  -f pasofi-backend/infra/production/router-control.compose.yaml \
  -f pasofi-backend/infra/production/approved-devices.compose.yaml \
  config --quiet
```

`PAMOFI_APPROVED_DEVICES_ENABLED` turns on the list (prepaid capability `approvedDevices`, network
`DEVICE_ALLOWLIST_ENABLED`). `PAMOFI_APPROVED_DEVICES_WRITE_ENABLED` separately allows changes and
router writes (`approvedDevicesWrite`, `DEVICE_ALLOWLIST_WRITES_ENABLED`). Both default to off.
The feature reads the router-control registry directly, so it works while
`PAMOFI_ROUTER_CONTROL_QUALIFIED=false` keeps the disconnect reconciler off.

## Acceptance on hardware

Software tests use a TLS RouterOS fixture and in-memory routers. On each real router, verify with
a test device:

1. Approve its MAC; confirm one tagged binding exists and the device browses without the portal.
2. Confirm untagged bindings (for example K1's uplink) are unchanged.
3. Remove it; confirm the tagged binding is gone and the portal appears again.
4. Disconnect the tunnel; confirm the router shows Unreachable and catches up after "Sync routers now".
