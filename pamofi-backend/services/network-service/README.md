# network-service

Independent build: `npm ci && npm test && npm run build`. Set `DATABASE_URL` to this service’s database before `npm start`. This initial implementation is not production-ready; see `../../docs/BUILD_STATUS.md`.

Apply owned migrations as a separate release step with `DATABASE_URL=... npm run migrate`. The database user must have migration privileges. This local-demo setup does not yet separate runtime and migration roles.

The separate `dist/radius-server.js` is a mutually authenticated HTTPS listener for the disposable RADIUS lab only. It requires the demo/development gate, explicit certificate paths, a pinned client-certificate fingerprint, its own `DATABASE_URL`, a lab prepaid URL and a scoped service secret. It does not start as part of the normal health service. NAS registration and temporary customer credentials in the lab are synthetic database fixtures; there is no production credential issuance or router management API yet. See `../../pamofi-radius/README.md` for the actual FreeRADIUS test and its limitations.

The integration test uses `PAMOFI_TEST_NETWORK_DATABASE_URL`, `PAMOFI_TEST_DATABASE_URL` and `PAMOFI_TEST_PREPAID_URL` against isolated test databases and a lab-only prepaid listener; without these variables it is skipped. Never point it at production. It creates short-lived certificates and tests the actual TLS listener and service boundary.
