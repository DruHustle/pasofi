# prepaid-access-service

Independent build: `npm ci && npm test && npm run build`. Set `DATABASE_URL` to this service’s database before `npm start`. This initial implementation is not production-ready; see `../../docs/BUILD_STATUS.md`.

Apply owned migrations as a separate release step with `DATABASE_URL=... npm run migrate`. The database user must have migration privileges. This local-demo setup does not yet separate runtime and migration roles.

The outbox dispatcher is disabled by default. To run it, configure `OUTBOX_DISPATCH_ENABLED=true`, `NOTIFICATION_URL` and a separate `INTERNAL_EVENTS_SECRET` of at least 32 bytes. Non-demo operation requires HTTPS and rejects the example secret. It retries with a bounded lease and backoff; only one service-owned database pool connection is used. The current notification consumer records a delivery-reference job but cannot send SMS.

The Pesepay callback and reconciliation worker are disabled by default and can only run in `APP_ENV=demo` and `NODE_ENV=development`. To qualify a real sandbox later, set `PAMOFI_PESEPAY_SANDBOX_ENABLED=true`, `PESEPAY_INTEGRATION_KEY`, `PESEPAY_ENCRYPTION_KEY`, `PESEPAY_APPLICATION_ID`, HTTPS `PESEPAY_RESULT_URL` and `PESEPAY_RETURN_URL`, and comma-separated HTTPS origins in `PESEPAY_CHECKOUT_ORIGINS`. Set the result URL to the externally reachable `/callbacks/pesepay` endpoint. Keep secrets out of source control and request logs. The callback is only a hint: fulfillment requires a separate, matched server-to-server status check. Initiated attempts are also queued independently of callbacks.

The worker uses database leases and retries pending or unverifiable checks with bounded backoff. A job marked `dead` needs operator investigation; a new authenticated callback will re-arm it. Inspect `payment_reconciliation_jobs` and `payment_reviews` without displaying credentials. This sandbox path has not been tested with Pesepay, and production payments remain disabled until provider qualification, monitoring, and operations are in place.
