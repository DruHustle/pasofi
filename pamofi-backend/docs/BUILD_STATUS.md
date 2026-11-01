# Build status

## Scope and plan

The requested end state is a full prepaid Wi-Fi platform with financial, access and network safety properties. This is an early implementation, not that completed product. The initial goal is a working isolated service skeleton and honest catalogue/help slice before implementing transaction and RADIUS authority. See ARCHITECTURE.md for the sequence.

## Implemented

- Five separately packaged Node/TypeScript/Fastify services with liveness and database readiness checks, separate database roles and databases in local Compose. Identity has an initial origin-checked, rate-limited customer session flow backed by PostgreSQL and HttpOnly opaque cookies. It is not yet wired to purchases or recovery; retry after a lost first response without the cookie can create another identity.
- PostgreSQL-backed candidate catalogue, with exact requested prices, decimal byte limits serialized as strings, and durations. Demo seed publishes candidate products locally only.
- Tested, isolated lifecycle and counter/limit rules for future accounting: FIFO activation, deadlines, gigawords, regression uncertainty and absolute grant deadlines. These functions are not connected to RADIUS, a ledger or enforcement.
- Read-only FAQ service and responsive React customer interface with explicit demo labeling. The local UI can create and confirm simulated purchases and show their queued entitlements; it does not make real payments or connect devices.
- Local-only Docker Compose, development named volume, startup script, service-specific manifests and Dockerfiles. Each service now has a serialized, checksum-verified migration command; role separation still needs production implementation.

## Not implemented / do not use live

Recovery, staff/MFA, real-provider orders and payments, agent stock, vouchers, receipts, entitlement lifecycle, queues, grants and accounting, trusted NAS and FreeRADIUS, router scripts, cross-service authentication, events/outbox, SMS delivery, personal help, management, production operations, backups/restore, provider integration and production security are all outstanding. The required transactional, concurrency, fault, browser, RADIUS and restore acceptance checks are not yet complete. No live provider, router or backup destination has been touched. A clearly labeled frontend demo was deployed to Vercel; its API is not connected. This is not ready to sell Wi-Fi or enforce access.

The demo bootstrap creates roles and catalogue data only during first PostgreSQL volume initialization, then runs per-service migrations as a separate release step. The runner records checksums and serializes releases; production runtime/migration role separation is still required. Port binding is localhost only, demo credentials are public, and service APIs are not authenticated. The identity and prepaid OpenAPI files include their current session and mock-purchase routes; remaining contracts are incomplete.

## Repository layout

Only `pamofi-frontend` and `pamofi-backend` are tracked at the repository root. Infrastructure, router placeholders, documentation and development tools live within the backend folder. Each folder builds independently; the customer UI needs a separately running API for current data.

## Environment and evidence

- Workspace initially had empty frontend/backend directories. The nearest existing Git repository was the user's home directory; a local `git init` was blocked by the workspace `.git` write restriction. No parent Git data was changed.
- `npm test` and `npm run build` passed in the frontend and all five service directories. Service tests currently cover liveness only; frontend test is TypeScript checking.
- `docker compose up --build -d` built the services. The first initialization failed because a bind-mounted shell initializer could not execute; it was replaced by SQL and the partially initialized demo database repaired. A separate temporary PostgreSQL 17.11 cluster initialized from the SQL with five products.
- `node local-tools/check-demo.mjs` passed against the running stack, including exact catalogue amounts, string byte values, FAQ and five database readiness checks. A sampled identity-role connection to the prepaid database was denied; the full role matrix has not been tested.
- Recreating the PostgreSQL container retained the demo catalogue. That initially exposed stale reverse-proxy service DNS; the proxy now resolves service names dynamically, and the recreation/smoke check passed after the fix.
- Initial frontend output was 71.53 KB gzipped JavaScript (Vite build output). Browser host was unavailable; no visual inspection, Playwright journeys, screenshots or accessibility audit were completed.
- The reorganized backend bootstrap was run against the existing demo volume. A clean temporary database initialization was tested separately; a complete clean-clone bootstrap remains unverified.

## Next commands

```sh
./local-tools/'manual deployment'/start-demo.sh
curl http://127.0.0.1:18082/v1/bundles
curl http://127.0.0.1:18085/v1/help
```

Next engineering step: implement secure customer identity and a testable PostgreSQL transaction/migration framework, followed by the global grant and trusted accounting path. Before claiming end-to-end acceptance, complete every omitted feature and the physical/provider qualifications in the supplied brief.

## Deployment investigation — 1 November 2026

- Private GitHub repository created with only the frontend and backend folders at its root.
- Vercel project `pamofi` is deployed at https://pamofi.vercel.app. Vercel assigned its first deployment to production. It is explicitly labelled as a demo; its API is not configured and returns 404. It does not support purchase or hotspot access.
- Oracle CLI reauthenticated. The requested fallback VM is shared with multiple existing services and has limited disk/memory headroom. It was inspected read-only. No PamoFi backend has been deployed or changes made to the VM. A separate A1 VM may exceed the current Always Free allocation; do not assume it is free.
- Counter arithmetic tests pass, including values greater than 2^32 and conservative handling of regressions. The prepaid migration was run twice against demo PostgreSQL, applying once. This does not verify ledger or RADIUS functionality.

Identity integration: migrations applied locally and `PAMOFI_TEST_DATABASE_URL=... npm test` passed with real PostgreSQL. Cookie-bearing repeat requests reuse the same identity; lost first-response idempotency and cross-service authorization remain unimplemented.

Fresh-checkout verification: cloned commit f2521e2 into a temporary directory, then independently ran `npm ci`, `npm test` and `npm run build` in the frontend and all five service directories under Node 24. All passed. The identity PostgreSQL integration test was skipped in that clean-checkout run and was separately run against the local demo database.

The revised demo bootstrap built all five service images, ran their owned migrations, and started the services against the existing demo volume. The subsequent catalogue/help/readiness smoke check passed; an origin-checked identity request returned 201 and a foreign-origin request returned 403. This is not a production deployment.

## Local simulated purchase slice

- Demo-only order creation snapshots published bundle terms, scopes the idempotency key to the authenticated customer and rejects mismatched retries. A short-lived signed service token lets prepaid access resolve the forwarded session through identity; the owner does not trust browser-supplied customer IDs.
- Demo confirmation serializes each order and atomically creates one mock payment record and one queued entitlement. It does not call Pesepay or grant connectivity. Demo order creation and confirmation require both `APP_ENV=demo` and `NODE_ENV=development`; production and unset environments disable them.
- `node local-tools/check-purchase-demo.mjs` passed against the running isolated PostgreSQL services, including concurrent order retries, eight concurrent confirmations, foreign-owner rejection, origin rejection and forged identity rejection. Identity integration also checked token issuer, scope and expiry.
- Playwright with installed Chrome passed a customer mock purchase, access view and reload at widths 320, 360 and 1280; screenshots were inspected locally. Initial JS: 72.23 KB gzipped; the purchase view is separately lazy-loaded at 2.13 KB gzipped.
- Remaining critical work includes real provider adapters and reconciliation, durable recovery, staff/MFA, agent/voucher workflows, global grant and accounting authority, FreeRADIUS and router integration, outbox/inbox, operational backups and restore, production hardening and real-world qualification. This is not a working prepaid hotspot.

To run the mock journey locally, start the backend with `./local-tools/'manual deployment'/start-demo.sh`, then run `npm ci && npm run dev -- --host 127.0.0.1` from `pamofi-frontend` and visit `http://localhost:5173`. Run `node local-tools/check-purchase-demo.mjs` from the backend. For browser tests, set `PAMOFI_CHROME_PATH` to an installed Chrome executable and run `npm run test:browser` in the frontend while the demo is running.

## Access ledger work in progress

The prepaid service now has PostgreSQL grant and cumulative-accounting domain functions. A per-customer advisory lock and partial unique index prevent concurrent active or uncertain reservations, and retries with the same customer/site/NAS/request return the original grant and absolute deadline. Cumulative upload and download are stored as numeric high-water values; duplicate records do not double debit, regressions/overages mark uncertainty, and a Stop conservatively retains the reservation. Actual trusted NAS authentication, network-service wiring, FreeRADIUS, verified termination/reconciliation and production access enforcement are not implemented. These functions are not exposed over HTTP and cannot connect a customer.

Run the integration check after demo migrations with `PAMOFI_TEST_DATABASE_URL=... npm test` from the prepaid service. Tests use random, self-cleaning fixture records in the specified test database. Do not point the test at production.

## Agent and delivery primitives

The prepaid database has agent inventory, immutable sale snapshots, encrypted 16-character vouchers, single-source entitlements and a transactional outbox. Internal domain functions serialize stock debits, bind idempotency to the agent and payload, redeem once, and race replacement against redemption. These functions are not exposed to agents until staff authentication and pairing are implemented. No real payment is recorded and no SMS is sent.

A service-owned outbox dispatcher can claim work with bounded leases and retries; the notification service validates scoped JWTs and atomically commits an inbox row and delivery-reference job. Duplicate content is acknowledged once, conflicting duplicates are rejected, and dead-letter replay records an actor and reason. The dispatcher is disabled by default; jobs stop at `awaiting_delivery_details`, since secure delivery lookup and SMS adapters are not implemented.

Real PostgreSQL tests passed concurrent stock exhaustion, 20 issuance/replacement race runs, grant reservation and duplicate accounting, plus cross-service outbox retry, lost acknowledgement simulation, conflicting duplicate detection, bounded acknowledgement validation and audited replay. The test suite runs database integration files serially while exercising concurrency inside each scenario; use isolated disposable databases with no other pending events. These tests are not provider, router, restore or production acceptance.

## Sendai adapter work in progress

The notification service has a Sendai send/retrieve adapter and a PostgreSQL attempt ledger. API acceptance remains `submitted` until a `delivered_at` signal is observed; charge amounts retain their original currency and ten-thousandth scale. Submissions with no provider ID become `unknown` and are not retried automatically. Tests cover concurrent sends, timeout ambiguity, late provider responses and canceled jobs. The adapter is not connected to automatic delivery, no provider credentials have been configured, and no real SMS has been sent. Secure delivery-reference lookup, authorized resend, mock sink, provider sandbox and handset delivery tests are still outstanding. Official API reference: https://docs.sendai.co.zw/api/sms/.
