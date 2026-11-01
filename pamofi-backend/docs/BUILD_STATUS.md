# Build status

## Scope and plan

The requested end state is a full prepaid Wi-Fi platform with financial, access and network safety properties. This is an early implementation, not that completed product. The initial goal is a working isolated service skeleton and honest catalogue/help slice before implementing transaction and RADIUS authority. See ARCHITECTURE.md for the sequence.

## Implemented

- Five separately packaged Node/TypeScript/Fastify services with liveness and database readiness checks, separate database roles and databases in local Compose. Identity has an initial origin-checked, rate-limited customer session flow backed by PostgreSQL and HttpOnly opaque cookies. It is not yet wired to purchases or recovery; retry after a lost first response without the cookie can create another identity.
- PostgreSQL-backed candidate catalogue, with exact requested prices, decimal byte limits serialized as strings, and durations. Demo seed publishes candidate products locally only.
- Tested, isolated counter/limit arithmetic for future accounting, including gigawords, regression uncertainty and absolute grant deadlines. It is not connected to RADIUS, a ledger or enforcement.
- Read-only FAQ service and responsive React customer interface with explicit demo labeling. No customer purchase or connection is claimed.
- Local-only Docker Compose, development named volume, startup script, service-specific manifests and Dockerfiles. Each service now has a serialized, checksum-verified migration command; role separation still needs production implementation.

## Not implemented / do not use live

Purchase integration with identity, recovery, staff/MFA, orders and payments, agent stock, vouchers, receipts, entitlement lifecycle, queues, grants and accounting, trusted NAS and FreeRADIUS, router scripts, cross-service authentication, events/outbox, SMS delivery, personal help, management, production operations, backups/restore, provider integration and production security are all outstanding. The required transactional, concurrency, fault, browser, RADIUS and restore acceptance checks are not yet complete. No live provider, router, backup destination or deployment has been touched. This is not ready to sell Wi-Fi or enforce access.

The demo bootstrap creates roles and data only during first PostgreSQL volume initialization. A separate per-service migration runner records checksums and serializes releases; production runtime/migration role separation is still required. Port binding is localhost only, demo credentials are public, and service APIs are not authenticated. The initial OpenAPI files cover health endpoints only.

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
