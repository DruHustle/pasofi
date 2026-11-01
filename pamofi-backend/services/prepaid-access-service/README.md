# prepaid-access-service

Independent build: `npm ci && npm test && npm run build`. Set `DATABASE_URL` to this service’s database before `npm start`. This initial implementation is not production-ready; see `../../docs/BUILD_STATUS.md`.

Apply owned migrations as a separate release step with `DATABASE_URL=... npm run migrate`. The database user must have migration privileges. This local-demo setup does not yet separate runtime and migration roles.

The outbox dispatcher is disabled by default. To run it, configure `OUTBOX_DISPATCH_ENABLED=true`, `NOTIFICATION_URL` and a separate `INTERNAL_EVENTS_SECRET` of at least 32 bytes. Non-demo operation requires HTTPS and rejects the example secret. It retries with a bounded lease and backoff; only one service-owned database pool connection is used. The current notification consumer records a delivery-reference job but cannot send SMS.
