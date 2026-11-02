# notification-service

Delivery keeps a validated provider message ID even when the send response has invalid status, timestamp, or charge fields. Such an attempt remains `unknown`; it cannot be submitted again automatically. `pollAttempt` may reconcile an unknown attempt only when that ID is present, using read-only provider retrieval. Missing or mismatched evidence leaves the state unchanged, and a canceled job stays canceled. An unknown attempt without a provider ID still requires operator investigation. Provider acceptance alone never proves handset delivery.

Independent build: `npm ci && npm test && npm run build`. Set `DATABASE_URL` to this service’s database before `npm start`. This initial implementation is not production-ready; see `../../docs/BUILD_STATUS.md`.

Apply owned migrations as a separate release step with `DATABASE_URL=... npm run migrate`. The database user must have migration privileges. This local-demo setup does not yet separate runtime and migration roles.

The private `POST /internal/v1/events` validates a short-lived service JWT and records an inbox row and delivery-reference job atomically. Duplicate events return success only if their immutable content matches. The job remains `awaiting_delivery_details` until a secure delivery payload is available. A Sendai adapter and an attempt ledger are implemented and tested with a fake provider, but are not wired into automatic delivery; no real SMS has been sent.
