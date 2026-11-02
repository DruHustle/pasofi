# PamoFi backend

PamoFi Wi-Fi Hotspot by Onesa. Five independent services implement a tested development foundation for prepaid Wi-Fi. **This is a demonstration and laboratory system, not a live Wi-Fi sales service.**

The web demo can create a customer session, simulate a bundle purchase, show queued access, recover that account in another browser, and sign out. Backend domain functions cover agent stock, vouchers, payment reconciliation, delivery attempts, grant reservations and cumulative accounting. Those functions are not all exposed as customer or staff journeys. No real purchase, SMS delivery or customer internet connection is available.

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

Open <http://localhost:5173>. Vite proxies the customer APIs to the backend. Each service has its own manifest, lockfile, Dockerfile, migrations and API contract; there are no frontend imports of backend code.

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

The private Oracle staging configuration publishes no ports or bundles and disables demo payments and lab RADIUS. It is not a customer API. Production still needs completed staff and agent journeys, approved provider integrations, physical router qualification, secure ingress, separate migration/runtime privileges, independent encrypted backups, restore drills and operating evidence.

Do not use demo credentials or lab certificates on real infrastructure. A persistent Docker volume is not an independent backup; see [BACKUPS.md](docs/BACKUPS.md).
