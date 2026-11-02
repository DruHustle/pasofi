# prepaid-access-service

Independent build: `npm ci && npm test && npm run build`. Set `DATABASE_URL` to this service’s database before `npm start`. This initial implementation is not production-ready; see `../../docs/BUILD_STATUS.md`.

Apply owned migrations as a separate release step with `DATABASE_URL=... npm run migrate`. The database user must have migration privileges. This local-demo setup does not yet separate runtime and migration roles.

The outbox dispatcher is disabled by default. To run it, configure `OUTBOX_DISPATCH_ENABLED=true`, `NOTIFICATION_URL` and a separate `INTERNAL_EVENTS_SECRET` of at least 32 bytes. Non-demo operation requires HTTPS and rejects the example secret. It retries with a bounded lease and backoff; only one service-owned database pool connection is used. The current notification consumer records a delivery-reference job but cannot send SMS.

The Pesepay callback and reconciliation worker are disabled by default and can only run in `APP_ENV=demo` and `NODE_ENV=development`. To qualify a real sandbox later, set `PAMOFI_PESEPAY_SANDBOX_ENABLED=true`, `PESEPAY_INTEGRATION_KEY`, `PESEPAY_ENCRYPTION_KEY`, `PESEPAY_APPLICATION_ID`, HTTPS `PESEPAY_RESULT_URL` and `PESEPAY_RETURN_URL`, and comma-separated HTTPS origins in `PESEPAY_CHECKOUT_ORIGINS`. Set the result URL to the externally reachable `/callbacks/pesepay` endpoint. Keep secrets out of source control and request logs. The callback is only a hint: fulfillment requires a separate, matched server-to-server status check. Initiated attempts are also queued independently of callbacks.

The worker uses database leases and retries pending or unverifiable checks with bounded backoff. A job marked `dead` needs operator investigation; a new authenticated callback will re-arm it. Inspect `payment_reconciliation_jobs` and `payment_reviews` without displaying credentials. This sandbox path has not been tested with Pesepay, and production payments remain disabled until provider qualification, monitoring, and operations are in place.


## Reconciliation and customer history

Payment review outcomes remain attached to the exact provider charge on retries. A duplicate charge never reports an entitlement it did not create, and a consumed-access reversal remains pending review. A verified reversal observed before success is recorded without granting access; an older success response cannot undo it. A reference conflict also blocks another initiation for that order until investigation. Only the adapter's explicit `verified_success` result can fulfill an order.

`GET /v1/access` shows active access first, the usable FIFO queue next, and historical purchases afterward. Optional `limit` (1–100, default 100) and `offset` (0–1,000,000, default 0) paginate the authenticated customer's records; `hasMore` and `nextOffset` indicate another page. All service responses use `Cache-Control: no-store` so customer history, entitlement data and internal authority responses are not cached.


If a provider initiation returns a valid reference but a missing or untrusted checkout URL, the attempt remains uncertain and exposes no redirect. The reference is retained and a verification job is scheduled so the payment can be reconciled without initiating a second charge.

Idle PostgreSQL connection failures are handled without terminating the process; readiness still depends on a successful database query. SIGTERM and SIGINT close the HTTP server, stop dispatch timers, await in-flight work, and close pools. A 10-second shutdown deadline prevents an indefinitely stalled stop.
