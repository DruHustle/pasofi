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

## Paid invoice delivery

`invoice.issued` version 1 carries only `{invoiceId}`; its aggregate ID is the same invoice UUID. Prepaid emits it in the payment transaction when email or SMS was requested. A download-only invoice remains available in prepaid without a notification job. Notification commits the event inbox and one unique `invoice_jobs` row together. Conflicting duplicates fail; an identical retry never creates another send.

The invoice worker retrieves private details and, for email, the saved PDF from `/internal/v1/invoices/:id` and `/:id/pdf`. Lookup JWTs use `INTERNAL_DELIVERY_SECRET`, issuer/subject `notification`, audience `prepaid-access`, scope `invoice:read`. The saved recipient, invoice identity, PDF size/magic, simulation mode and SMS link origin/expiry are checked before any attempt. The event/job tables never contain an email address, phone, PDF, message or bearer token.

| Configuration | Requirements |
| --- | --- |
| Worker | `INVOICE_DELIVERY_WORKER_ENABLED=true`, valid `PREPAID_URL`, delivery secret of at least 32 bytes. |
| Demo email/SMS | `APP_ENV=demo`, `NODE_ENV=development`, corresponding `INVOICE_EMAIL_MODE=mock` or `INVOICE_SMS_MODE=mock`. SMS also needs valid `PUBLIC_ORIGIN`. No provider request; mock evidence contains hashes only. |
| Resend email | Production environment, `INVOICE_EMAIL_MODE=resend`, `INVOICE_EMAIL_QUALIFIED=true`, verified `INVOICE_EMAIL_FROM`, `RESEND_API_KEY`. Production entrypoint supports `RESEND_API_KEY_FILE`. |
| Sendai SMS | Production environment, `INVOICE_SMS_MODE=sendai`, `INVOICE_SMS_QUALIFIED=true`, registered 1–11 character alphanumeric `INVOICE_SMS_FROM`, existing Sendai live/qualified flags and API key, valid HTTPS `PUBLIC_ORIGIN`. This is a paid-provider path. |

All production modes default to disabled. Optional `infra/production/invoice-delivery.compose.yaml` and `invoice-sms.compose.yaml` require a separately restricted provider egress network and protected file secrets. They do not enable sales or change payment/network gates. Qualification includes verifying sender control and actual receipt using an operator-owned test address/phone before offering the channel to customers. Automated tests use synthetic providers only.

Resend sends the stored PDF as a base64 attachment over HTTPS with a stable invoice-job idempotency key. Provider acceptance means `submitted`; read-only provider polling must confirm delivery. Ambiguous responses and crashed submissions become `unknown`, never an automatic second send. A rejected 429 request can be retried after the provider delay. A known bounce/rejection becomes `failed`. Investigate unknown deliveries using the provider dashboard before taking any manual action; do not reset an unknown job to queued. Customers retain the original download even if delivery fails.

The private endpoints `/internal/v1/invoice-delivery/capabilities` and `/internal/v1/invoices/:id/status` require issuer/subject `prepaid-access`, audience `notification`, scope `invoice:status`. Capabilities describe configured channels; status reports `queued`, `submitting`, `submitted`, `delivered`, `failed`, `unknown` or `canceled`, with safe timestamps/error codes and simulation indication. Prepaid enforces customer/staff ownership before exposing sanitized status publicly. A delivered email means the recipient's mail server accepted it; it does not prove someone read it.

The operations diagnostic reports `invoice_ambiguous`, `invoice_failed` and invoice jobs unresolved after 15 minutes as `invoice_delayed`. It exposes aggregate counts only. The normal test runner removes all invoice and Resend configuration from inherited environments, so local or hosted tests cannot use an operator's real provider configuration.

Implementation and provider setup: [Paid invoices](../../docs/PAID_INVOICES.md).
