# PamoFi backend

PamoFi Wi-Fi Hotspot by Onesa. Five independent services implement customer identity, staff/MFA, site-scoped commerce, prepaid accounting, delivery and network lifecycle authority. **The source and isolated journeys are implemented; live service activation still requires provider, router and deployment qualification.**

The web application exposes customer vouchers/private receipts, gated checkout and verified status, recovery/handoff, staff password/MFA and pending approval, assigned-site agent stock/sales, and administrator catalogue/allocation/audit/network review. The strict browser gate exercises a real isolated administrator-to-agent-to-customer sale and redemption journey, alongside failure mocks. Network disconnect/reconciliation and delivery workers have independent service tests. Actual payment, SMS and physical hotspot acceptance remain disabled until explicitly qualified; no source change creates a merchant account, public host or live customer connection.

See [current build status](docs/BUILD_STATUS.md), [architecture](docs/ARCHITECTURE.md) and [testing](docs/TESTING.md) for the precise boundaries.

## Run the local demo

Requirements: Node.js 24 LTS, npm, Docker and Docker Compose. From this folder:

```sh
./local-tools/'manual deployment'/start-demo.sh
```

The script installs and builds each backend independently, starts PostgreSQL, applies each service's migrations and waits for all five readiness checks. From `pamofi-frontend/web`, run:

```sh
npm ci
npm run dev
```

Open <http://localhost:5173>. Vite proxies the explicitly allowed customer/staff/admin APIs to their owning services. Each service has its own manifest, lockfile, Dockerfile, migrations and API contract; there are no frontend imports of backend code.

The demo seeds five candidate bundles, uses public test credentials, and enables simulated purchases only with both `APP_ENV=demo` and `NODE_ENV=development`. Keep this configuration local. Services bind to host loopback ports 18081–18085 and PostgreSQL to 55432. Data persists in the development-only `pamofi-demo-db` volume.

```sh
node local-tools/check-demo.mjs
node local-tools/check-purchase-demo.mjs
docker compose stop
```

Restart with `docker compose up -d --wait`. Stopping containers retains the volume. There is no automatic destructive reset.

## Verify changes

Run `npm test` in each service, or use the repository verification runner in [TESTING.md](docs/TESTING.md). Database tests skip when their test variables are absent; a unit-only pass is **not** integration acceptance. The integration runner requires explicitly isolated loopback databases and rejects skipped integration tests.

Docker images consume locally built `dist` directories. Build before creating an image. Run migrations as a separate release step, not an application startup side effect.

## Operations boundary

The private Oracle staging configuration publishes no ports or bundles and disables demo payments and lab RADIUS. It is not a customer API. The production source now includes TLS gateway contracts, protected secret-file loading, separate owner/migration/runtime privileges and an independent pgBackRest/B2 backup overlay. These require an authenticated public host, trusted certificates, real secret/key custody, provider and physical-router qualification, monitoring, off-host restore/fencing drills and operating evidence. The first router was inspected read-only; its approved customer HotSpot configuration and management tunnel have not been activated.

Do not use demo credentials or lab certificates on real infrastructure. A persistent Docker volume is not an independent backup; see [BACKUPS.md](docs/BACKUPS.md).
