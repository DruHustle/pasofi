# notification-service

Delivery keeps a validated provider message ID even when the send response has invalid status, timestamp, or charge fields. Such an attempt remains `unknown`; it cannot be submitted again automatically. `pollAttempt` may reconcile an unknown attempt only when that ID is present, using read-only provider retrieval. Missing or mismatched evidence leaves the state unchanged, and a canceled job stays canceled. An unknown attempt without a provider ID still requires operator investigation. Provider acceptance alone never proves handset delivery.

Independent build: `npm ci && npm test && npm run build`. Set `DATABASE_URL` to this service’s database before `npm start`. This initial implementation is not production-ready; see `../../docs/BUILD_STATUS.md`.

Apply owned migrations as a separate release step with `DATABASE_URL=... npm run migrate`. The database user must have migration privileges. This local-demo setup does not yet separate runtime and migration roles.

The private `POST /internal/v1/events` validates a short-lived service JWT and records an inbox row and delivery-reference job atomically. Duplicate events return success only if their immutable content matches. The reference contains no phone or voucher. Notification resolves details through prepaid's authenticated `GET /internal/v1/deliveries/:id`, using a separate `INTERNAL_DELIVERY_SECRET` and JWT issuer/subject `notification`, audience `prepaid-access`, scope `delivery:read`. Response identity, size, simulation mode and destination are validated. HTTPS is required outside demo/development; redirects are refused. Receipt-only jobs are canceled without an SMS attempt.

## Explicit delivery modes

The worker and providers are disabled by default. Enable a worker only with `DELIVERY_WORKER_ENABLED=true`, valid `PREPAID_URL` and an `INTERNAL_DELIVERY_SECRET` of at least 32 bytes. Missing lookup configuration keeps delivery disabled.

| Mode | Requirements | Behavior |
| --- | --- | --- |
| `NOTIFICATION_DELIVERY_MODE=mock` | `APP_ENV=demo`, `NODE_ENV=development` | Synthetic delivery, no provider request. The sink stores only a message hash and last four recipient digits. |
| `NOTIFICATION_DELIVERY_MODE=sendai` | `APP_ENV=production`, `NODE_ENV=production`, `SENDAI_LIVE_ENABLED=true`, `SENDAI_QUALIFIED=true`, `SENDAI_API_KEY` | Explicitly qualified live adapter path. Demo settings cannot enable it. |

Qualification flags record a separate operating decision; tests do not perform provider qualification. Automated verification uses mock/fake providers and has not activated live Sendai. `DELIVERY_WORKER_AUTOSTART=false` is for controlled tests invoking a single iteration directly. Normal operation claims jobs with leases, retries details with bounded backoff, and marks the job failed after ten unsuccessful lookups. A stale submission becomes unknown, never a second automatic send.

## Status and explicit resends

The following private endpoints require JWT issuer/subject `prepaid-access`, audience `notification`, signed with the delivery secret:

| Endpoint | Scope | Contract |
| --- | --- | --- |
| `GET /internal/v1/delivery/capabilities` | `delivery:status` | `{enabled,mode,simulation}`. |
| `GET /internal/v1/deliveries/:id/status` | `delivery:status` | Latest job state/timestamps/safe error code and attempts with delivery/charge metadata; no phone, voucher, body or provider credential. |
| `POST /internal/v1/deliveries/:id/resend` | `delivery:resend` | `{requestId,actorId,reason}`; UUID IDs and reason 10–500 characters. |

Resend requires every prior job for the reference to be terminal (`delivered`, `failed`, `canceled`). Unknown, submitting and otherwise unresolved work blocks resending. A new audited job retrieves the same voucher and saved recipient; it creates no new voucher or entitlement. Repeating the same request ID/payload returns the original job; changed content conflicts. The public prepaid boundary supplies the authenticated staff actor and enforces current role, site, ownership and origin.

Database tests require isolated `PAMOFI_TEST_DATABASE_URL` and run serially because workers claim the global service queue. All responses use `Cache-Control: no-store`. Idle database failures preserve process liveness; readiness still queries the database. Shutdown stops timers, awaits in-flight delivery and then closes pools under the bounded service deadline. Production deployment, monitoring, backup recovery and provider qualification remain separate acceptance work.
