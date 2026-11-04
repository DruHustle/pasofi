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

## Verification and deployment limits

Use the repository's strict runner with isolated database URLs: `node pasofi-backend/local-tools/verify.mjs --integration --browser`. It requires every configured integration test to run and rejects skips. Individual service tests without the explicit isolated database variables can skip integration cases; that is not a release qualification.

Coverage includes credential retry races and key rotation, scoped private routes, actual mutual-TLS RADIUS requests, counter/generation binding, and a real local HTTPS RouterOS test server exercising lookup/delete/re-query, wrong usernames, redirects and untrusted certificates. The Docker packet lab also sends actual FreeRADIUS packets. These prove software behavior, not the physical router's enforcement. The inspected first router still needs its approved HotSpot setup, trusted HTTPS management, private reachability and hardware tests for byte limits, reboot, missing accounting, simultaneous logins and disconnect before enabling production flags.

Router API contract: [official MikroTik REST API documentation](https://help.mikrotik.com/docs/spaces/ROS/pages/47579162/REST+API).

Authorization rechecks the current credential verifier, expiry/revocation and NAS registration after its ledger request returns, before emitting Access-Accept. The worker uses a five-second wall-clock abort as well as socket inactivity limits, so a trickling REST response cannot indefinitely hold its reconciliation loop. NAS UUIDs are normalized before matching the database registry. A pending grant with no Accounting-Start becomes eligible for reconciliation after three minutes; this schedules independent investigation without releasing or inventing usage.

**Physical qualification must cover in-flight and cached Access-Accept replies.** Revoking a database credential rejects new authorization and the application rechecks it after a pending ledger lookup, but cannot retract a reply already sent to FreeRADIUS or cached/in flight toward the NAS. Before enabling real access, prove the router/FreeRADIUS retry and reply-cache lifetimes and verify a sufficient quiet interval or an independent router-side fence before final absence is used to release a reservation. The local fake-router tests do not establish that hardware guarantee. Keep production flags disabled until this delayed-reply scenario passes; missing evidence must retain the reservation.
