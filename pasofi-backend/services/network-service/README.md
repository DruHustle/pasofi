# network-service

Independent build: `npm ci && npm run build`. The service owns its database, NAS registry, temporary network credentials and router observations. The prepaid-access service owns customers' entitlements and the usage ledger. No cross-service database access is required.

Apply migrations separately with the migration identity before starting runtime processes. The local demo uses a disposable database owner; the [production foundation](../../infra/production/README.md) separates owner, migration and restricted runtime roles. Production network access remains disabled until the actual router, private transport and accounting behavior pass acceptance. See [build status](../../docs/BUILD_STATUS.md) and the [first-router inspection](../../pasofi-routeros/site-01/INSPECTION.md).

## Customer credentials and registered sites

The ordinary HTTP service exposes two **private** routes: `GET /internal/v1/network/sites` and `POST /internal/v1/network/credentials`. Only prepaid-access can call them using a short-lived HS256 service token with the exact issuer, subject, audience and `network:sites` or `network:credentials` scope. They are not public gateway routes. Customer-facing `/api/network/*` requests go through prepaid-access, which verifies the customer session, usable entitlement, existing grants and account holds.

Both `PAMOFI_CUSTOMER_NETWORK_ENABLED=true` and the applicable RADIUS gate are required. Demo uses `APP_ENV=demo`, `NODE_ENV=development` and `INTERNAL_RADIUS_ENABLED=true`; non-demo requires `PAMOFI_RADIUS_QUALIFIED=true`. Missing keys, database or service authentication fail closed. Configure a dedicated random `INTERNAL_NETWORK_SECRET` of at least 32 bytes.

The enabled NAS registry supplies site identity and the HTTPS HotSpot `/login` URL. Login URLs cannot contain a query, fragment or embedded credentials. The caller cannot choose a router endpoint. The credential request takes `customerId`, `siteId` and a UUID `requestKey`. It creates a two-minute NAS-bound random username/password, stores a SHA-256 verifier and an AES-256-GCM delivery copy, and limits new issuance to ten credentials per customer per minute. A retry returns the same credential without extending expiry. Disabled sites, mismatched retries, expired/revoked credentials and unavailable encryption keys are rejected.

`RADIUS_CREDENTIAL_KEYS` is a JSON object mapping positive integer key versions to independent 64-hex-character keys; `RADIUS_CREDENTIAL_KEY_VERSION` selects new issuance. Retain old keys until their delivery windows have expired, then rotate deliberately. Production loads these values from individual secret files through the common entrypoint. Never put a real key, password, voucher or router credential in Git, URLs or logs.

## RADIUS listener and accounting

The separate `dist/radius-server.js` process terminates mutual TLS for FreeRADIUS. Configure `RADIUS_CA_FILE`, `RADIUS_SERVER_CERT_FILE`, `RADIUS_SERVER_KEY_FILE`, the exact SHA-256 `RADIUS_CLIENT_FINGERPRINT`, its own network `DATABASE_URL`, `PREPAID_URL` and the scoped service secret. It is not automatically started by the ordinary HTTP process. Its bind address defaults to loopback. A production listener requires the explicit qualification gate and an HTTPS prepaid endpoint with certificate verification; demo HTTP is allowed only behind the demo gates.

FreeRADIUS's authenticated client mapping supplies `X-PamoFi-NAS`; arbitrary NAS identifiers in incoming accounting attributes are not trusted. Authorization binds the credential, registered NAS/site, ledger grant, generation and session. Responses carry the ledger correlation in `Class`, a conservative session deadline and RouterOS byte limits. Accounting combines octets and gigawords, and acknowledges only after a durable ledger write. Start, Interim-Update, Stop and NAS Accounting-On/Off are supported. NAS restart fences live grants and revokes that NAS's credentials. See [the packet lab](../../pasofi-radius/README.md) for real FreeRADIUS coverage.

## Disconnect and reconciliation

The optional worker starts only with `NETWORK_RECONCILER_ENABLED=true`. It polls prepaid-access for up to 50 pending grants, revokes the corresponding credential first, queries the configured RouterOS active HotSpot session by exact generated username, deletes matching session IDs, then queries again. A successful DELETE alone is never proof of absence. Requests use HTTPS with normal certificate validation, bounded responses, five-second timeouts and no redirects. A private CA can be supplied per router.

`ROUTEROS_ROUTERS_FILE` points to a protected JSON array. Each entry contains `nasId`, an HTTPS `url` ending exactly in `/rest/`, `username`, `password` and optionally `caFile`. Use the dedicated restricted router account approved for this operation. Configure only inspected management endpoints reachable through the private network. No user-provided URL is accepted. Keep this file outside the repository and mount it only into the network process.

The worker submits independently observed absence plus credential-fencing evidence bound to the grant/site/NAS/generation/session. The ledger releases a reservation only when durable final accounting and fresh independent absence agree. Missing Stop, counter regression, late higher usage, unreachable routers and ambiguous responses retain the reservation or account hold. The administrator review flow requires explicit evidence and audited final counters; it cannot silently reset a customer's balance. Shutdown cancels pending router requests before the database pool closes.

## Central router fleet management

The staff application can use a single approved administrator session to inspect
and change explicitly enrolled routers through this service. The browser never
receives a router endpoint, service password or CA file. Prepaid-access verifies
the current approved staff session, MFA and administrator role on every request,
then signs a short-lived internal token. This service requires the exact
prepaid-access issuer/subject, network audience and `router-fleet:read` or
`router-fleet:write` scope, plus an `actorId` UUID and positive decimal-string
`actorVersion`. A browser cookie or caller-supplied actor body is insufficient.

`ROUTER_FLEET_ENABLED=true` enables the private fleet API; both
`ROUTER_FLEET_WRITES_ENABLED=true` and a device's `allowWrites: true` are needed
to prepare, apply or prepare a rollback. Both switches default off. They are
independent of the sales, customer network and RADIUS qualification gates, so a
registered router can be inspected while customer access remains disabled.
Reconciliation observes an earlier uncertain operation without writing to the
router and remains available when write qualification is disabled.

`ROUTEROS_FLEET_FILE` must name an absolute, regular, non-symlink JSON file,
outside the repository, not writable by group or others. Put the file in the
protected production secret directory and mount it only into network-service.
Use a **separate restricted RouterOS account** from the disconnect reconciler:
RouterOS serializes requests belonging to the same user. Each of at most 100
entries has this shape; all values below are placeholders:

```json
[
  {
    "nasId": "11111111-1111-4111-8111-111111111111",
    "url": "https://10.77.0.2/rest/",
    "username": "pasofi-fleet",
    "password": "REPLACE_IN_PROTECTED_FILE",
    "caFile": "/run/secrets/router-fleet-ca/11111111-1111-4111-8111-111111111111.pem",
    "expectedSerial": "COPY_FROM_INSPECTED_HARDWARE",
    "allowWrites": false,
    "targets": [
      {"key": "identity", "kind": "identity"},
      {"key": "customer-comment", "kind": "interface", "name": "wlan1"},
      {"key": "customer-radio", "kind": "wireless", "name": "wlan1"}
    ]
  }
]
```

Every NAS must already exist in this service's registry. Hardware serials and
canonical endpoints must be unique across entries, so two NAS aliases cannot
bypass the per-device write fence. Enrollment does not
insert, enable or reassign a NAS. Production endpoints must use HTTPS on port
443 at exactly `/rest/`, with no credentials, query or fragment in the URL.
Literal endpoints must be private IPv4 addresses; DNS answers are restricted
to private IPv4 addresses at connection time. Certificates and hostnames are
verified against the configured public CA, with no redirect following. The
explicit demo/development pair permits loopback and ephemeral ports for local
HTTPS tests. The expected hardware serial is mandatory and is checked before
configuration reads, again before every write, and during readback. A target
list contains 1–16 unique, inspected names/keys; no API can add a new target or
choose a RouterOS path, command, endpoint or method.

| Target kind | Permitted fields | RouterOS menu |
| --- | --- | --- |
| `identity` | `name` | `system/identity` |
| `interface` | `comment` | `interface` |
| `wireless` | `ssid`, `disabled` | `interface/wireless` |
| `wifi` | `configuration.ssid`, `disabled` | `interface/wifi` |
| `hotspot-profile` | `rate-limit`, `idle-timeout`, `keepalive-timeout` | `ip/hotspot/user/profile` |

Only inspected customer radios and profiles should appear in this list. An
SSID change or disabling a customer radio can interrupt those customers;
review the preview before applying. Management/uplink interfaces, security,
firewall/NAT/routing, WireGuard, VLAN/bridge topology, device users, passwords,
RADIUS secrets, scripts, imports, resets, reboots and firmware changes are not
supported. RouterOS models lacking the expected menu or explicit SSID field
fail closed for that target. An MR20 or other non-RouterOS access point requires
a separately qualified adapter.

The private contract lives under `/internal/v1/router-fleet/routers`:

| Method and suffix | Result |
| --- | --- |
| `GET /` | Registered inventory, configuration availability and write qualification; registration alone is not an online observation |
| `GET /:id` | Live verified device and allowed target values, field descriptions, per-target revisions and observation time |
| `GET /:id/changes` | Most recent 50 saved changes |
| `GET /:id/changes/:changeId` | Saved execution status |
| `POST /:id/changes` | Prepare one target with `{targetKey, expectedRevision, values, reason, requestKey}` |
| `POST /:id/changes/:changeId/apply` | Apply a prepared change, body `{}` |
| `POST /:id/changes/:changeId/reconcile` | Observe an uncertain or stale applying change after its `reconcileAfter`, body `{}` |
| `POST /:id/changes/:changeId/rollback` | Prepare a new inverse change with `{reason, requestKey}`; does not write yet |

A preview takes a fresh bounded snapshot, rejects revision drift, stores
immutable nonsecret before/after values, and expires in ten minutes. UUID
request keys bind to the normalized payload and original actor; an identical
retry returns the same plan. The original actor at the same staff security version
must apply the plan through a fresh authorized session. A status read atomically
expires an elapsed, still-prepared plan, so a lost apply response can eventually
resolve even when the request never started. Per-NAS row locks and a partial unique index prevent
another fleet write while any change is `applying` or `uncertain`. Runtime
privileges must allow SELECT/INSERT/UPDATE on `router_fleet_changes` and only
SELECT/INSERT on `router_fleet_events`. A database trigger prevents rewriting
the approved plan, actor, request binding, expiry or rollback provenance.

Before contacting the mutating endpoint, the service commits `applying` with
an attempt ID and a conservative 90-second `reconcileAfter`. It verifies the
live revision, hardware identity, qualification and current enrollment before
writing. Singleton settings use `POST .../set`; named records use `PATCH` to the
verified literal `*` record ID. Only a matching readback establishes `applied`.
A proved unchanged response is `unchanged`; conflicting observations are
`diverged`. Failures before any write are `failed`. An expired plan is `expired`.

The settlement bound relies on the qualified direct RouterOS REST contract:
commands stop at the documented 60-second timeout, including requests abandoned
by their client, and requests for the same account execute serially. A setter
must start within 20 seconds of the saved attempt, allowing five seconds for
HTTPS, sixty for RouterOS execution and a five-second margin before the
90-second observation boundary. A delayed handler fails without sending a
write. Background execution and `/execute` are never available here. Verify
these behaviors on the actual RouterOS version before qualification; the test
simulator does not establish a hardware timeout guarantee.

An HTTP timeout, dropped connection or lost readback leaves `uncertain`, even
if the first observation still resembles the before state. RouterOS can finish
a command after the client abandons its request. Repeated apply requests never
resend a started operation. After the settlement boundary, reconciliation
reads without mutating and resolves to `applied`, `unchanged` or `diverged`;
unreachable or mismatched hardware remains fenced. It also recovers an
`applying` record left by a process crash. Rollback requires the live state to
still equal the prior applied state and creates a separate, reviewable inverse
plan. There is no blind retry, automatic rollback, whole-device restore or
cross-router bulk write.

These functions use the existing private hub-to-router transport. They do not
enable router-to-router forwarding or expose WebFig/REST publicly. Current
RouterOS REST requires an account with both `api` and `rest-api` policies;
use `read` and add `write` only for qualified devices, without default full
administrator privileges. See the [official REST guide](https://manual.mikrotik.com/docs/developer-guides/rest-api/).

## Verification and deployment limits

Use the repository's strict runner with isolated database URLs: `node pasofi-backend/local-tools/verify.mjs --integration --browser`. It requires every configured integration test to run and rejects skips. Individual service tests without the explicit isolated database variables can skip integration cases; that is not a release qualification.

Coverage includes credential retry races and key rotation, scoped private routes, actual mutual-TLS RADIUS requests, counter/generation binding, and a real local HTTPS RouterOS test server exercising lookup/delete/re-query, wrong usernames, redirects and untrusted certificates. The Docker packet lab also sends actual FreeRADIUS packets. These prove software behavior, not the physical router's enforcement. The inspected first router still needs its approved HotSpot setup, trusted HTTPS management, private reachability and hardware tests for byte limits, reboot, missing accounting, simultaneous logins and disconnect before enabling production flags.

Fleet tests add a real trusted-HTTPS simulator for all five allowlisted target
kinds, exact singleton/record mutation methods, serial mismatches, hostile
record IDs, redirects, untrusted certificates, bounded responses, value
validation and protected registry files. The PostgreSQL fleet integration test
uses `PAMOFI_TEST_NETWORK_DATABASE_URL` and exercises actor/scope gates,
concurrent apply, replay, immutable plans, drift, inverse previews, lost and
late responses, process-crash fences, audit events and read-only recovery when
writes are disabled. It never sends a request to a real router. Physical
qualification must establish the actual device's TLS, service policies,
approved target names, configuration readback and delayed-command behavior
before any production write switch is enabled.

Router API contract: [official MikroTik REST API documentation](https://help.mikrotik.com/docs/spaces/ROS/pages/47579162/REST+API).

Authorization rechecks the current credential verifier, expiry/revocation and NAS registration after its ledger request returns, before emitting Access-Accept. The worker uses a five-second wall-clock abort as well as socket inactivity limits, so a trickling REST response cannot indefinitely hold its reconciliation loop. NAS UUIDs are normalized before matching the database registry. A pending grant with no Accounting-Start becomes eligible for reconciliation after three minutes; this schedules independent investigation without releasing or inventing usage.

**Physical qualification must cover in-flight and cached Access-Accept replies.** Revoking a database credential rejects new authorization and the application rechecks it after a pending ledger lookup, but cannot retract a reply already sent to FreeRADIUS or cached/in flight toward the NAS. Before enabling real access, prove the router/FreeRADIUS retry and reply-cache lifetimes and verify a sufficient quiet interval or an independent router-side fence before final absence is used to release a reservation. The local fake-router tests do not establish that hardware guarantee. Keep production flags disabled until this delayed-reply scenario passes; missing evidence must retain the reservation.
