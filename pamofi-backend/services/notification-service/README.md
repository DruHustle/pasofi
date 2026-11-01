# notification-service

Independent build: `npm ci && npm test && npm run build`. Set `DATABASE_URL` to this service’s database before `npm start`. This initial implementation is not production-ready; see `../../docs/BUILD_STATUS.md`.

Apply owned migrations as a separate release step with `DATABASE_URL=... npm run migrate`. The database user must have migration privileges. This local-demo setup does not yet separate runtime and migration roles.

The private `POST /internal/v1/events` validates a short-lived service JWT and records an inbox row and delivery-reference job atomically. Duplicate events return success only if their immutable content matches. The job remains `awaiting_delivery_details` until a secure delivery payload is available. A Sendai adapter and an attempt ledger are implemented and tested with a fake provider, but are not wired into automatic delivery; no real SMS has been sent.
