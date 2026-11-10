# Commission the Pasofi hotspot for cash customers

This is the ordered handoff from the prepared Mac/backend/router software to an observed customer service. Complete it for each actual site. A deployed website, running RADIUS process, sales-location record or passing laboratory test does not establish that a customer can buy, connect, use the purchased allowance, disconnect and reconnect.

**Live acceptance remains pending until the evidence below is collected.** This document does not record an Oracle deployment, router import, cash transaction or physical test. Earlier records of Kuwadzana's isolated pilot, Lawfield's bootstrap, HotSpot device-mode restrictions and a hAP lite memory/kernel failure must be rechecked on the actual equipment. Do not infer their present state from a source file.

The launch path is **cash received by an approved agent → private receipt and downloadable invoice → customer redemption → paid HotSpot session**. Cash receipt/PDF access requires no unfinished SMS, email, card or mobile-money provider. Keep digital checkout disabled. The independent provider investigation and qualification are not prerequisites for this cash commissioning exercise.

## 1. Establish the installation and recovery record

Use the exact qualified release bundle, with its source commit, archive hash, CI evidence and migration list. On your Mac, follow [MAC_DEPLOY.md](../local-tools/manual%20deployment/MAC_DEPLOY.md). If the existing installation references are missing, run the package's read-only `hotspot-readiness.command` first, following [HOTSPOT_READINESS.md](../local-tools/manual%20deployment/HOTSPOT_READINESS.md). The collector reports unknowns; its successful exit is not customer readiness.

Record the following privately before changing a runtime:

| Installation evidence | Required observation |
| --- | --- |
| Oracle identity | Existing SSH alias, independently verified host key, Compose project, original ordered Compose/environment-file paths, retained PostgreSQL system identifier and current images. No sample alias or inferred database identity. |
| Recovery | Recent independent database backup, retained encryption-key versions, demonstrated restore procedure, sufficient disk space, previous images/configuration and local router recovery access. |
| Each site | Physical location, router serial/model, RouterOS version and matching package inventory, actual Starlink/uplink and guest port/radio/bridge arrangement. Inspect any external access point's bridge/NAT behavior. |
| Service transport | Non-overlapping private addresses, actual WireGuard interfaces and ports, each source `/32`, host/cloud firewall policy and source address seen by RADIUS after Docker routing. |
| Identity and TLS | Real sales-location UUID, unique NAS UUID/client name, exact router HTTPS login origin, private RouterOS REST URL, certificate names/SANs, expiry and trusted CA. |

Keep credentials, raw Docker configuration, voucher codes, customer recovery details, NAS secrets and private keys out of reports/screenshots. Use private evidence references for sensitive records. Do not replace a missing installation fact with an example value.

The gates have separate purposes:

| Existing source/configuration | Meaning |
| --- | --- |
| `PAMOFI_COMMERCE_ENABLED` in prepaid | Global receipt pairing, voucher redemption and agent sales availability, also requiring the valid delivery keyring and configuration. This is broader than pausing one selling location. |
| `sales_locations.enabled` and `status_version` | New sales availability at one location. The approved-admin action below changes these only; it does not qualify Wi-Fi. |
| `PAMOFI_RADIUS_QUALIFIED`, `radius-qualified` profile | Prepared/qualified private RADIUS transport and authority. Customer credential issuance remains separate. |
| `radius_nas.enabled` in the network database | Trusted NAS eligibility for authentication **and accounting**. It is not the sales-location status. |
| `PAMOFI_CUSTOMER_NETWORK_ENABLED` in prepaid and network | Customer temporary-credential issuance. The public `networkAccess` capability also checks its required authority/configuration. |
| `PAMOFI_ROUTER_CONTROL_QUALIFIED` | Input to `router-control.compose.yaml`, mapped to `NETWORK_RECONCILER_ENABLED`. Required for the managed disconnect/absence cycle. |
| `salesLocationStatus`, `routerFleet`, `routerFleetWrite` capabilities | Availability of specific administration contracts. None enables commerce or customer connections. Fleet administration and session reconciliation use separate configuration. |

Keep `PAMOFI_PAYMENTS_ENABLED=false`, `PAMOFI_PAYMENT_MODE=disabled` and unqualified delivery channels disabled. Do not use demo/simulation mode to represent a real cash receipt.

## 2. Upgrade the application while preserving its existing gates

In the extracted qualified Mac release folder, run:

```sh
/bin/bash ./release-deploy.command
```

Supply only the established installation references. Review the preflight's exact service/overlay/database scope before its apply step. The [deployment engine](../local-tools/manual%20deployment/RELEASE_DEPLOY.md) retains the complete existing overlay order, named database volume, secrets and launch gates. It runs owned pending migrations and role grants before replacing applications. This release adds prepaid `031_sales_location_status.sql`; retain all earlier applied migrations, including the paid-invoice migration `030_paid_invoices.sql`.

Check the deployment's private completion/rollback record and actual running images. A later failure can leave completed migrations or some replaced applications; use the recorded state to recover. Check readiness through the real gateway and authenticated staff session, not just a static homepage.

The Mac upgrade explicitly protects **`postgres`, `radius` and `radius-api`**. A new `network` application image does not update the separate RADIUS authority image or its mounted source. Verify the protected authority independently in the next stage. Do not describe the application upgrade as a complete RADIUS upgrade.

When the new prepaid service is deployed, `GET /v1/capabilities` advertises `salesLocationStatus:true`; authenticated `GET /v1/staff/sites` returns each reviewed decimal-string `version`. The new website requires this capability and a version before displaying a status action. With an older Oracle API it remains read-only for this feature.

In **Staff → Administration → Sites → Sales locations**, an approved MFA-verified administrator can review an existing location and enable/pause new sales with a reason. The service contract is `PATCH /v1/admin/sites/:id`, UUID `Idempotency-Key`, and `{enabled,expectedVersion,reason}`. Reasons are 10–500 characters. A stale version requires a fresh review. A matching retry returns the original audited result without reapplying it over a later decision; refresh the current list. Migration `031` increments versions when status changes, and append-only `commerce_audit` entries use action `site.status`.

This action serializes against the new-sale transaction. A pause preserves prior-sale replay, private paid receipts, invoices, stock/history and purchased allowances. Keep unrelated uncommissioned selling locations paused. Stock allocation currently requires an enabled sales location; prepare the test location's stock while global commerce remains closed, then pause it until the controlled test window. Creation alone is not a launch decision.

## 3. Qualify the separate RADIUS authority and its ensure timer

Follow [infra/radius-production/README.md](../infra/radius-production/README.md) and inspect the actual `radius` and `radius-api` definitions. They must agree on the prepared client identity, private bindings, immutable images, transport CA, client/server certificates, pinned client fingerprint, service secret and runtime network-database identity. The authority talks to prepaid over the existing verified private HTTPS boundary; it receives no prepaid database or migration credential.

For the recorded Onesa first-site installation, `onesa-radius-ensure.py` deliberately pins container names `pamofi-production-radius-1` and `pamofi-production-radius-api-1`, image IDs, source/certificate paths, networks and listeners. Its `pamofi-radius-ensure.timer` can restart those exact containers every five minutes. **Before an intentional replacement/shutdown of those services**, first pause and drain existing customers as in stage 9, record the installed timer's state, and stop its automatic restoration. On the confirmed host where these units are installed, the existing unit commands are:

```sh
systemctl disable --now pamofi-radius-ensure.timer
systemctl stop pamofi-radius-ensure.service
```

Execute them through the existing authorized administrative access. They are not part of a generic Mac application upgrade. Check for an in-progress service invocation. Inspect and requalify the replacement authority/transport and update the ensure script's pins to those exact reviewed definitions before restoring the previously agreed schedule. The service depends on `wg-quick@pfi-site01.service` and `pamofi-site01-guard.service`; check both. A test run of the installed `pamofi-radius-ensure.service` may start the reviewed containers by design. Record a successful real boot/timer check before claiming automatic recovery.

New material comes from `infra/radius-production/prepare.mjs`; its `nas-registration.sql.review` deliberately inserts `enabled=false`. Apply only the reviewed exact registration with the network migration/owner role after migrations. Verify its real prepaid site UUID, unique NAS/client name, source `/32` and HTTPS login URL. Never upsert over an unexplained existing identity or reuse laboratory secrets. Generated transport certificates last 90 days; arrange renewal and fingerprint replacement before expiry.

Check the complete selected Compose merge, including `infra/radius-production/compose.yaml`, before controlled activation. UDP 1812/1813 must bind only to the reviewed Oracle WireGuard address. The mTLS authority has no public host port. The NAS must originate requests from its own registered tunnel address; packet-supplied `NAS-Identifier` does not choose trust. Verify the pre-DNAT/post-SNAT host guards and outside-host exposure; a private Docker bind alone does not prove firewall isolation.

For Lawfield or another dedicated link, inspect the actual Oracle endpoint port and router local listener separately. The [site-link planner](../infra/site-link/README.md) now supports `routerInterface` and `routerListenPort`; the RADIUS router planner accepts the matching optional `pasofi-service` argument. The checked-in RADIUS Compose overlay binds **one** private address. A second dedicated Oracle link therefore needs an explicitly reviewed routing/listener/host-guard integration. Do not copy the pinned first-site guard or ensure definitions and assume they cover the second site.

## 4. Qualify private HTTPS session reconciliation

Follow [ROUTER_CONTROL.md](../infra/production/ROUTER_CONTROL.md). Prepare `PAMOFI_ROUTER_CONTROL_DIR` with protected `routers.json` and the exact public CA files. Each entry binds one registered `nasId` to its reviewed private `https://…/rest/` URL and restricted per-device account. The certificate must match that URL; test actual DNS/routing, TLS verification, credentials and permitted HotSpot session operations. Never mount a CA signing key or router private key.

With the established environment loaded, run the source preflight:

```sh
node pasofi-backend/infra/production/preflight-router-control.mjs
```

Its `prepared-only` result validates local material; it cannot prove live reachability or permissions. Include `router-control.compose.yaml` after the chosen base/Vercel/RADIUS files in the complete deployment configuration. Confirm its actual `ROUTEROS_ROUTERS_FILE`/CA mounts and the controlled activation value of `NETWORK_RECONCILER_ENABLED` before the paid-session test. The reviewed site firewall must admit only the intended Oracle/router private addresses and TCP443 after source NAT.

The reconciler must revoke the temporary credential, query that credential's `/rest/ip/hotspot/active` sessions, remove only the returned matching IDs and independently query again. Missing TLS/authority/reachability remains uncertain. A working central **Routers** dashboard does not prove this separate worker can finish a customer session. Without it, a Stop can leave the first session reserved and block the next connection.

## 5. Prepare an isolated physical customer network and portal

Keep general customers off the test SSID while commissioning. Save the inspected router configuration and recovery method. Verify HotSpot is permitted by the actual RouterOS device-mode state and that the matching installed package/version supports the intended configuration. If a device-mode change requires physical confirmation, an on-site person must complete and observe it; no remote script substitutes for that confirmation.

Inspect guest ports/radio, bridge membership, DHCP/DNS, upstream NAT, local management, client isolation and any external access point. An access point must preserve the intended per-client HotSpot identity. Do not transplant Kuwadzana addresses or topology into Lawfield.

The old Kuwadzana pilot scripts deliberately retain/add `PamoFi pilot:` and `PasoFi test:` forwarding drops, including guest forwarding and IPv6 restrictions. They are isolation artifacts, not a finished internet policy. **Do not delete all pilot drops or enable all disabled objects.** Prepare and review a separate change plan for the exact inspected rule order: necessary DHCP/DNS/HTTPS captive access, authenticated public forwarding, trial limits if offered, exact portal reachability, return traffic, FastTrack interaction, blocked private/management networks and IPv6 behavior. Preserve an immediate rollback and use the documented RouterOS dry-run/Safe Mode procedure.

Qualify the exact trusted **HTTPS** HotSpot login. The implemented RADIUS contract requires PAP's `User-Password`, a stable `Acct-Session-Id` and Message-Authenticator across the encrypted service link. Reject unsupported CHAP/EAP/MSCHAP and insecure login fallbacks. Inspect actual attributes without exposing credential material. Do not treat an unaudited trial, local user, MAC or cookie bypass as a successful paid connection.

For an app that remains usable after welcome expiry, deploy and test the [dedicated HTTPS customer portal](../infra/production/HOTSPOT_PORTAL.md). Its web build uses `VITE_PASOFI_HOTSPOT_PORTAL=1`, `hotspot-portal.compose.yaml`, `PASOFI_HOTSPOT_WEB_DIR`, the qualified origin aliases and the existing portal preflight. Allow only the exact dedicated public IP/TCP443 through the reviewed guest policy; broad Vercel/shared-CDN allowlisting can admit unrelated sites. This separate origin has its own host-only cookies, so use the existing recovery/explicit handoff when appropriate.

Generate site-specific welcome assets using [the welcome site's configuration instructions](../pasofi-routeros/portal/welcome/README.md#select-the-site-and-verified-portal-origins). Supply the inspected `siteLabel`, `hotspotOrigin` and qualified `appOrigin`. `build-install.mjs` changes copied HTML/profile directory only. It does not enable HotSpot, trial, forwarding, RADIUS or sales.

If the welcome offer is included, physically prove its intended two minutes per device per 24 hours, 1 Mbps upload/3 Mbps download, expiry and repeat-login restriction. RouterOS trial eligibility is MAC-based and is separate from paid account allowance. With mobile data disabled, test actual iOS and Android captive discovery, HTTPS, the fallback button, countdown/status and post-expiry app/account access. An expired unauthenticated device must still be blocked from unrelated internet, private networks and management ports. Keep native cookie capability unqualified until its own actual-device checks pass.

## 6. Run one controlled cash purchase through the paid connection

This stage is a limited commissioning window, not public opening. Inspect all currently enabled NASes and sales locations before changing global flags. Activate only the reviewed test NAS/router/customer path and the necessary scoped runtime inputs after stages 1–5 are ready. Keep unqualified locations paused and untested radios isolated. Do not create an “enable everything” script. Record actual before/after configuration and how to pause issuance without cutting accounting.

1. **Prepare seller and terms.** Use a real approved agent with completed MFA and the correct site assignment, published immutable bundle terms/currency, allocated stock and an open cash shift. Verify commission and any opening cash count. The controlled test location must be enabled for sales; enabling it does not configure its router. Use the real production mode for a genuine controlled cash transaction; simulated receipts cannot be evidence of money received.
2. **Pair and receive cash.** The customer creates a private cash reference for the correct bundle/location. The agent looks it up, checks exact amount/currency and receives the actual cash before confirming. Select private receipt/downloadable invoice delivery. The recorded payment is the agent's attestation, not independent verification of banknotes or a card settlement.
3. **Recover the result.** Observe one sale, one stock decrement, one voucher and one immutable paid invoice. Retrieve the customer's private receipt and PDF and the agent's authorized invoice. A retried uncertain request uses its original key and body; it must recover the same sale/invoice without taking cash or stock twice. Keep actual voucher codes private. Do not wait for unfinished SMS/email delivery to perform this test.
4. **Redeem explicitly.** Redemption must create/recover one owned entitlement with the purchased byte/validity terms. It queues allowance; it does not start a router connection or create another cash receipt. Check the account's usage/access snapshot and recovery method before moving devices or origins.
5. **Connect on the actual test Wi-Fi.** With mobile data disabled, use the customer connection flow for the registered site. The temporary credential must be bound to the intended NAS and exact HTTPS login URL. Observe the router's admitted session and authenticated RADIUS Start, then real traffic and Interim-Updates. Wrong, expired or wrong-site credentials must fail.
6. **Reconcile the evidence.** Confirm customer, NAS/site, grant/generation/session correlation, purchased terms, observed router limits and actual use. The ledger activates allowance when authenticated Start arrives; its conservative activation timestamp is the grant's issue time. The UI polls more frequently than RADIUS reports: the configured interim interval is 60 seconds, so a five-second screen refresh is not a five-second network meter.

Use the ordinary UI/authenticated boundaries. These service routes identify the actual workflow for operators; do not put staff cookies or customer credentials into a shared command history:

| Step | Existing service route |
| --- | --- |
| Customer pairing / agent lookup | `POST /v1/receipt-pairings`; `POST /v1/staff/cash-references/lookup` |
| Cash confirmation / receipt | `POST /v1/staff/sales`; `GET /v1/staff/sales/:id/receipt`; `GET /v1/receipt-pairings/:id` |
| Invoice download | `GET /v1/staff/invoices/:id/pdf`; paired customer's `GET /v1/customer/invoices/:id/pdf` |
| Redeem / allowance | `POST /v1/vouchers/redeem`; `GET /v1/access`; `GET /v1/usage` |
| Connect / current session | `GET /v1/network/sites`; `POST /v1/network/credentials`; `GET /v1/network/session` |
| Disconnect | `POST /v1/network/disconnect` |

The canonical frontend maps these suffixes to `/api/`; the dedicated customer portal maps them to `/portal-api/`. `/v1/` above is the service contract, not an instruction to expose private services directly.

## 7. Prove settlement, reconnect, limits and the second site

**Required sequence: paid connection → Start/Interim → Stop → independent router absence → closed grant → reconnect with remaining allowance.** A displayed logout, Stop packet, vanished browser window or absence observation alone is insufficient.

Request disconnect through the customer flow. Keep RADIUS, the private tunnel, HTTPS management and the reconciler available. Observe credential revocation, session removal/re-query, a matching final Stop without accounting anomaly and the ledger's transition to `closed`. Until that evidence agrees, the grant remains uncertain/reserved and another connection must be refused. Once closed, reconnect the same account on the same site; the original purchased allowance/validity must continue and usage must not reset or double-charge.

Then qualify the second site's complete stages 1–6. Move that **same account** there after the first session closes and show the remaining allowance follows it. Attempt simultaneous use at the two sites and verify the one-open-grant restriction. Record deliberate disconnect/device handoff in both directions. A two-site sales list or router dashboard is not cross-site acceptance.

Use clearly identified controlled test allowances and observed transfers to prove:

- Upload-only, download-only and combined totals agree with the authoritative cumulative accounting. Repeated/out-of-order accounting must not debit the same bytes twice. Qualify the high-word/byte-counter boundary as part of the actual supported traffic range; laboratory evidence alone does not prove that router's meter.
- Actual byte exhaustion stops internet at the router and cannot create free access on reconnect. Actual validity/session timeouts and an expired unused start-by allowance are rejected. If a short test bundle is needed, create explicit immutable test terms through the existing approved catalogue workflow during the isolated window; do not edit purchased terms or balances to fake a pass.
- Separately interrupt the Starlink uplink, private tunnel and router. Verify recovery, missing-accounting conservatism, no duplicate allowance, correct reboot handling and eventual independent termination evidence. Keep unresolved grants held.
- Test actual simultaneous client load on each hAP lite, including memory, CPU, uptime, traffic and captive responsiveness. Earlier memory/kernel failure makes stability under the intended workload a specific outstanding qualification. Record a measured customer limit and test duration; do not publish a capacity promise from the model name or a lab pass.

An accounting outage or anomaly requires evidence, not manually marking a grant closed. The existing **Network reviews** workflow (`GET /v1/admin/network/reviews`, `POST /v1/admin/network/reviews/:id/resolve`) requires an approved administrator, current reviewed version, reason/evidence reference, bounded final totals and fresh independent fencing/absence evidence. Do not substitute zero usage, delete holds, reset allowances or reuse a stale absence observation merely to make reconnect work.

## 8. Open only the accepted service and monitor it

Use the [two-site checklist](TWO_SITE_HOTSPOT_ACCEPTANCE.md) to retain the actual signed-off observations, including exceptions. Publicly open a site only after its cash-to-reconnect/limits/isolation/stability evidence is complete. If only one site qualifies, describe availability accurately and keep the other isolated. Confirm which staff locations are enabled, the approved stock/shift procedure and the measured initial customer limit. Record the responsible operator and recovery contact through the established operating process.

On the qualified host, with its reviewed complete stack/environment already selected, run:

```sh
node pasofi-backend/infra/operations/check.mjs --queues --with-backups
```

Follow [operations/README.md](../infra/operations/README.md). `PAMOFI_OPERATIONS_COMPOSE_FILE` must name the absolute rendered **complete** stack, including its qualified backup overlay; `PAMOFI_OPERATIONS_PROJECT` scopes the existing project. For the split deployment, use the actual Oracle `PAMOFI_MONITOR_ORIGIN`, Vercel `PAMOFI_MONITOR_FRONTEND_ORIGIN` and exact private `PAMOFI_OPERATIONS_RADIUS_BIND`. Do not invent values or inspect a different project to obtain a green result.

Verify an actual scheduled check and alert receipt, external HTTPS monitoring, queue/hold observations, certificate expiry, disk/WAL, backups and a retained restore test. Missing checks are `not_checked`, not passes. The command reports aggregate evidence and does not perform a cash sale, router acceptance, alert delivery or capacity test.

## 9. Pause, drain and roll back safely

1. **Pause new cash sales locally** using the audited sales-location action and a reason. Refresh its current version/status and tell the operating staff through the established process. The per-location pause retains receipts, idempotent sale recovery, stock and account history. Avoid using the broader global commerce gate for an ordinary location pause; it also gates receipt-pairing/redemption/private-voucher routes.
2. **Pause new network credentials** with the reviewed customer-network gate in prepaid/network. This does not itself disconnect an existing session or instantly revoke an already-issued temporary credential. Preserve customer session/usage reads and disconnect requests. Keep the authority, tunnel, runtime ledger and reconciler available to settle sessions.
3. **Drain and account.** Obtain the final Stop/absence/closed evidence for active sessions, or retain explicit unresolved holds. Do not set `radius_nas.enabled=false` first: both authentication and accounting require an enabled registered NAS, so that could reject the final accounting needed for safe settlement. Do not stop RADIUS/private HTTPS simply because the sale screen is paused.
4. **Perform the scoped maintenance.** After the drain decision, disable the exact NAS/transport only when the reviewed maintenance plan requires it. Handle `pamofi-radius-ensure.timer` before any planned protected RADIUS stop/replacement; otherwise it may restore the very containers being stopped. Keep the local recovery path and unrelated site's service intact. An urgent safety outage may require immediate network isolation; record remaining sessions as uncertain and reconcile before reopening.
5. **Roll back compatible applications/configuration.** Review the deployment record's exact `rollback_command`, prior image/source hashes and original full overlay order. Preserve migration/audit history and the current database. Do not restore an older database over legitimate cash sales, invoices or network consumption. Incompatible/corrupt data recovery follows the independent fenced restore procedure and reconciles transactions since the recovery point.
6. **Reopen by evidence.** Recheck authority pins, private TLS, accounting/reconciliation, outstanding holds and the affected physical acceptance path. Restore the reviewed timer schedule only after its exact definitions pass. Re-enable the specific location/network path through the same reviewed controls, then repeat a controlled reconnect and actual traffic check before admitting general customers.

## Acceptance record — fill from observations

All rows begin **pending**. Attach timestamped private evidence references, responsible operator and the exact source/image/router versions; never attach secrets or full customer credentials.

| Gate | Kuwadzana | Lawfield / second actual site |
| --- | --- | --- |
| Physical device identity, package/device-mode and recovery | Pending | Pending |
| Backend migration/capability, protected authority and ensure pins | Pending | Pending |
| Private NAS source/bind/firewall and HTTPS reconciliation | Pending | Pending |
| Inspected forwarding, private/IPv6 isolation, portal after expiry | Pending | Pending |
| Welcome time/rate/repeat policy, if offered | Pending | Pending |
| Real controlled cash receipt/PDF, retry and owned redemption | Pending | Pending |
| Paid Start/Interim, measured totals, quota/time enforcement | Pending | Pending |
| Stop → absence → closed → reconnect | Pending | Pending |
| Same account across both sites; simultaneous-use rejection | Pending | Pending |
| Uplink/tunnel/router fault recovery and measured stable capacity | Pending | Pending |
| Monitoring/alerts, backup/restore, controlled pause and reopening | Pending | Pending |

No row becomes passed merely because its software exists, a flag is true or a deployment command exits successfully.
