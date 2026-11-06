# HotSpot commissioning preparation

This package uses a **private inspected router baseline** to prepare a
serial-pinned read-only collector, explicit missing-input report, disabled-NAS SQL for owner
review, inputs for the existing service-link/welcome generators, a read-only
staging check, and a customer acceptance record. It does not configure a router,
contact a server, generate credentials, enable sales, or establish cash-service
readiness.

## Private baseline and scope

Keep actual hardware serials, identities, interface/management inventory and
protected site IDs in a private baseline outside Git. `baseline.example.json`
contains **synthetic fixture values**, not any deployed router. Replace every
value from current observations. Do not use a remembered shared IP address as
proof of device identity.

The baseline records the inspected mode, package/version, active management
address, retired overlapping addresses, preserved recovery/CPE ports and
required route inventory. It is an operator-selected fact record, not evidence
that a connection still reaches that hardware. Generated scripts check the
serial again on the router.

On **SMIPS with RouterOS 7.20 or newer**, HotSpot requires the separate
`hotspot` package; `routeros` and `wireless` alone do not provide its menu.
MikroTik documents the split in the
[7.20 release notes](https://download.mikrotik.com/routeros/7.20/CHANGELOG).
The example baseline includes this package as synthetic installed inventory.
Record only packages actually observed on the selected device. Preparation
refuses a SMIPS 7.20+ baseline without `hotspot`; the staging check requires its
exact RouterOS version, enabled and installed (not merely available), with no
pending package action. A missing menu is not an empty HotSpot configuration.

Follow the [package installation procedure](https://manual.mikrotik.com/docs/7.25/getting-started/installation-and-upgrade/packages/)
for the exact installed RouterOS version and architecture: upload only the
reviewed ordinary `.npk`, reboot under the established recovery procedure, and
verify the installation log, package record and menu before updating the
private baseline. Inspect other pending package actions first. Do not use an
`.auto.npk` filename or substitute a RouterBOOT upgrade for the missing package.
Package installation and physical device-mode permission are separate checks;
these helpers neither perform nor combine their reboot procedures.

The staging check also requires `hotspot=yes`; it never
changes device-mode or reboots the router. If permission is currently disabled,
physical confirmation remains a separate step. The official
[7.25 device-mode guide](https://manual.mikrotik.com/docs/7.25/system-information-and-utilities/device-mode/)
and [update reference](https://manual.mikrotik.com/docs/7.25/cli-reference/system/device-mode/update/)
describe the physical-confirmation procedure and timeout.

Keep existing qualified services and tunnels intact. Historical site-01 pilot
files and site-02 preparation do not identify another router. Mac/server
deployment remains a separate operation.

## Collect once, without exporting credentials

Prepare the collector from the actual private baseline, even before the
remaining commissioning inputs are available:

```sh
node pasofi-backend/pasofi-routeros/commissioning/prepare.mjs \
  /absolute/protected/private-baseline.json --collect \
  /absolute/protected/collect-readiness.rsc
```

Run the generated `collect-readiness.rsc` in the identified router's terminal,
or upload it with its ordinary `.rsc` name and import it. Its first operation
checks the hardware serial. Explicit field allowlists omit private keys,
shared secrets, HotSpot passwords, lease/on-event scripts, DoH URLs, customer
sessions, vouchers and DHCP lease records. Unavailable fields are labelled
`unavailable`; they are not silently assumed to match the plan. Treat the
resulting network inventory as private operational information.

If a SMIPS 7.20+ baseline contains only `routeros` and `wireless`, collection
still works: it reports the missing HotSpot prerequisite and omits HotSpot menu
commands, while retaining the other metadata reads. It does not report zero
HotSpot objects. After the exact package is installed and verified, refresh the
private package inventory and regenerate the collector to include those menus.

The report is intentionally bounded. It does not establish peer reachability,
TLS validity, AP forwarding, Internet access or accounting. It does not scan
other routers. Keep any resulting output with the private commissioning record.

## Fill actual inputs, then prepare

From the repository root, this command immediately lists the remaining field
paths without creating files or echoing supplied values:

```sh
node pasofi-backend/pasofi-routeros/commissioning/prepare.mjs \
  /absolute/protected/private-baseline.json \
  pasofi-backend/pasofi-routeros/commissioning/plan.template.json --check
```

Exit status `2` means required inputs remain empty. The template deliberately
contains no invented site/NAS IDs, private allocations, keys or certificates.
Copy it to a protected working location and fill it from actual records. The
following inputs require distinct evidence:

| Input | Where it must come from |
| --- | --- |
| Site UUID and NAS UUID | Verified intended sales-site mapping and reviewed network-owner NAS allocation |
| Customer bridge/interfaces/subnet/pool | Inspected physical or VLAN topology and deliberate separation from management |
| Complete router/server route inventories | Fresh non-default IPv4 route reads; retain every required network in the inspected baseline |
| Service endpoint/ports/interface/public keys | Existing server integration review and keys generated on their originating devices |
| Distinct service `/32` addresses | Reviewed address allocation that overlaps neither side nor the selected customer network |
| HotSpot origin and certificate fingerprint | Selected customer HTTPS hostname and actual matching certificate |
| Separate application origin | Qualified customer application reachable after free welcome expires |
| Portal source/new target directories | Actual current HotSpot files and a fresh non-overlapping target |
| Private REST URL/account/certificate | Restricted per-device disconnect account and verified private TLS endpoint |

The current customer credential endpoint selects one enabled NAS for a site.
Reusing a site ID listed as protected in the private baseline is refused. A
fleet entry does not implement customer roaming or change that selection behavior.
If the product should use several gateways under one sales site, qualify that
software change separately before changing this restriction.

Do not place passwords, private keys, RADIUS secrets or PEM contents in the
plan. Unknown fields are rejected. A DNS management endpoint still requires
live proof that it resolves to the router's private service address; an IP literal must
match that address. Certificate fingerprints are metadata, not a replacement
for chain, hostname, validity-period and private-key-possession checks.

Once the inputs are complete:

```sh
node pasofi-backend/pasofi-routeros/commissioning/prepare.mjs \
  /absolute/protected/private-baseline.json /absolute/protected/site-plan.json --check

node pasofi-backend/pasofi-routeros/commissioning/prepare.mjs \
  /absolute/protected/private-baseline.json /absolute/protected/site-plan.json \
  /absolute/protected/new-site-review
```

The output parent must already exist. The tool creates a new mode0700 directory
outside the repository and mode0600 files, refusing any existing target. It
does not overwrite earlier reviews. `review.json` hashes the files and marks
every live gate pending, even when all input validation succeeds.

This is preparation for a fresh customer network. Select its subnet before
adding that subnet to the router. The overlap check rejects customer space
already present in the supplied route inventories rather than adopting an
uninspected existing network. Re-inspect changed topology before preparing a
replacement plan; do not remove an observed route merely to satisfy validation.

## Keep customer and management paths separate

The validator preserves the baseline's management bridge, WAN, recovery and
CPE transit interfaces, plus both reserved service-interface names. It will
not accept them as customer bridge members.
For a customer network carried over the CPE link, inspect and design the VLAN
path or a different management path first; moving the current CPE transit link
wholesale is outside this package. No port moves, VLAN changes, radio changes,
DHCP changes, firewall changes or guest activation commands are generated.

The later staging check expects a deliberately created, separate **disabled**
customer bridge, its inspected members, gateway, disabled DHCP, one disabled
HotSpot and disabled source-bound RADIUS. The management bridge and recovery
ports must remain available. The private service tunnel may be active for
management and controlled testing. This is a checkpoint before opening the
guest path, not a configuration installer.

Record actual MR20 revision/firmware/mode. Its native AP procedure and the
LAN-to-LAN fallback are different procedures; use the inspected model's guide.
Two phones must be visible individually at the intended MikroTik. Decide which
gateway owns each customer subnet; do not put customers through two HotSpots.
The relevant repository guide is `pasofi-backend/pasofi-routeros/MERCUSYS_MR20.md`.

## Existing generators and their boundaries

Run these tools from the source checkout. The generated review bundle is a
handoff record; it is not a standalone application or a deployment command.

| Tool | Use with the selected device values | Required review |
| --- | --- | --- |
| `infra/site-link/plan.mjs` | `site-link.public.json` and a new output directory | Fresh dedicated router interface/public key; existing hub, host firewall, listener and source routing integration; this generator is not an incremental repair tool |
| `infra/radius-production/router-plan.mjs` | `SITE_SLUG SERVER_IP ROUTER_IP PROTECTED_SECRET_FILE NEW_REVIEW.rsc ROUTER_INTERFACE` | Independently generated per-NAS secret, correct source `/32`, actual selected `pasofi-service` or `pamofi-service`; output creates a disabled client |
| `pasofi-routeros/portal/welcome/build-install.mjs` | `SOURCE_DIRECTORY NEW_DIRECTORY HOTSPOT_PROFILE NEW_REVIEW.rsc welcome-site.json` | Existing selected profile, matching DNS/certificate, source files, empty target and qualified application origin |
| `infra/production/preflight-router-control.mjs` | Protected runtime registry and per-NAS public CA files | Separate reconciler account, exact private REST endpoint and live disconnect/requery proof |

The paths above are under `pasofi-backend/`. Do not run
`infra/radius-production/prepare.mjs --new-install-only` against an existing
authority. This package reuses only its registration renderer to write
`nas-registration.sql.review` with `enabled=false`. It neither generates nor
replaces the authority's CA, existing client registry or shared secrets. Apply
that SQL only through the network owner/migration role after checking the
actual prepaid site and uniqueness; runtime/API credentials cannot register a
NAS. The `nas-enrollment.json` descriptor is for that handoff, not a replacement
live registry.

No existing generator is a complete per-device HotSpot/firewall installer. A reviewed
site-specific customer scaffold and policy are still required. Use HTTPS login
with PAP to the registered private RADIUS path, Message-Authenticator,
`use-radius=yes`, accounting, and one-minute interim updates. An optional free
welcome remains independently bounded; do not let CHAP, plaintext HTTP login,
local paid users, MAC authentication or cookies bypass the paid contract.

Before importing a later mutating review, verify the serial again, compare the
exact uploaded file digest, and use RouterOS 7.25 syntax checking:
`import file-name=REVIEW.rsc verbose=yes dry-run`. `dry-run` is a standalone flag.
It proves syntax only. Establish independent recovery and inspect the actual
firewall ordering before applying a reviewed change. Never name an upload
`.auto.rsc`. The package's own collector/staging scripts are read-only and do
not require a Safe Mode mutation transaction.

## Acceptance and release

Use `ACCEPTANCE.md` and the authoritative
`pasofi-backend/docs/CASH_HOTSPOT_LAUNCH.md`. The generated staging check observes
selected metadata only; it does not validate firewall ordering, private DNS/TLS,
certificate ownership, source preservation, customer radio isolation or real
cash/auth/accounting behavior. A successful staging check leaves all release
gates pending.

Fleet administration and paid-session termination are separate integrations.
Do not enable sales or issuance because a router appears in the fleet. Preserve
electronic-payment settings `PAMOFI_PAYMENTS_ENABLED=false` and
`PAMOFI_PAYMENT_MODE=disabled`. Qualify one real site and one controlled customer
path before opening it publicly.

## Local verification

```sh
node --test pasofi-backend/pasofi-routeros/commissioning/prepare.test.mjs
```

Tests exercise missing inputs, protected topology, overlapping allocations,
injection/credential rejection, read-only output, private file permissions and
no-overwrite behavior. They do not execute RouterOS or provide live evidence.
