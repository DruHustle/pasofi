# PamoFi

PamoFi Wi-Fi Hotspot by Onesa. **Early local demonstration; not a working prepaid hotspot.** This repository currently demonstrates a candidate catalogue read from PostgreSQL and basic help through separate Fastify services. Purchase, identity, voucher redemption, hotspot grants and staff functions are not implemented. Do not deploy or use for real customers.

## Start the disposable local demo

Requirements: Node.js 22+ (Node 24 LTS recommended), npm, Docker and Docker Compose. From this directory:

```sh
./local-tools/'manual deployment'/start-demo.sh
```

From `pamofi-frontend`, run `npm ci && npm run dev` to view the UI at <http://127.0.0.1:5173>; it proxies the two read-only backend APIs on this machine. Docker starts a local PostgreSQL instance with a named development-only volume and five independently packaged services. No live payments or SMS are configured. The first database initialization inserts candidate products as published **for this demo only**. Do not use the demo credentials, compose file or seed for production.

Run the smoke check with `node local-tools/check-demo.mjs`. Stop without deleting the data: `docker compose stop`. Restart: `docker compose up -d`. The demo database is exposed only on loopback at port 55432; the individual service development ports are 18081–18085. The `pamofi-demo-db` volume persists independently of the containers. There is deliberately no automated destructive reset.

Each service and the frontend has its own `package.json` and lockfile. Run `npm ci`, `npm test`, and `npm run build` in the relevant directory. Local API development also needs that service's `DATABASE_URL`; see its `.env.example` and Compose. The Docker images consume the locally built `dist` directories, so build first.

Read [build status](docs/BUILD_STATUS.md) for the implementation and verification boundary and [architecture](docs/ARCHITECTURE.md) before extending this project. Production deployment is not prepared.
