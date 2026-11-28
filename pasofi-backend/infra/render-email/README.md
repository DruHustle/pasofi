# PasoFi email on Render

The optional Render service runs only the authenticated email transport. The
existing Oracle notification service retains the durable job, recipient ownership,
private invoice/PDF lookup, retries and customer-visible delivery status. Resend
remains the email delivery provider. No database, SMS worker, payment endpoint or
public Oracle internal route is moved by this component.

`render.yaml` is a **disabled qualification candidate**, using the free Frankfurt
web service plan with automatic deployments off. It does not change either of the
existing `du-platform-api` or `portfolio-backend` services. It contains no credential
and starts without one. Publishing this file does not create or qualify a service.

## Build and configuration

| Setting | Value |
| --- | --- |
| Blueprint path | `pasofi-backend/infra/render-email/render.yaml` |
| Root directory | `pasofi-backend/services/notification-service` |
| Node | `24.22.1` |
| Build | `npm ci --include=dev && npm run build` |
| Start | `node dist/email-relay-server.js` |
| Readiness | `/health/ready`; reports the `RENDER_GIT_COMMIT` revision and whether delivery is enabled |
| Sender | `PasoFi <notifications-pasofi@onesa.eu>`; fixed in the reviewed contract |

This entrypoint does not load `DATABASE_URL`, start notification workers, run
migrations or contact Oracle. It binds `0.0.0.0` on Render's supplied `PORT`.
Logging is disabled for requests, recipients, attachments and provider exceptions.
The only unauthenticated responses are bounded health metadata and generic errors.

Both `INVOICE_EMAIL_RELAY_ENABLED=true` and
`INVOICE_EMAIL_RELAY_QUALIFIED=true`, explicit production environments, an approved
`RESEND_API_KEY` and a separate `INVOICE_EMAIL_RELAY_SECRET` are required to enable
the relay. The shared relay secret must have at least 32 bytes and must not reuse
the Oracle database, internal-delivery, session, Stripe or another product's key.
Provide existing approved credentials only through Render's protected environment
settings. No credential is generated, copied or issued by these files.

Keep the existing Resend account and `onesa.eu` sending domain. The fixed sender is
the selected address, **not evidence that its current domain or mailbox delivery
has been qualified**. Read-only provider retrieval needs a Resend key that supports
email retrieval as well as sending; a send-only key cannot support this contract.
Reconcile the existing approved credential's permissions before cutover.

The candidate Blueprint explicitly restores both flags to false when applied.
Before a later qualified activation, review the production configuration source
of truth; do not re-sync the disabled candidate over an activated service and
assume the flags will remain enabled. Blueprint omission preserves existing
environment variables; adding a `sync: false` secret later does not populate an
existing service automatically.

## Authenticated transport

| Request | Scope | Behavior |
| --- | --- | --- |
| `GET /v1/products/pasofi/invoice-email/capabilities` | `email:status` | Reads configuration only; makes no provider request |
| `POST /v1/products/pasofi/invoice-email` | `email:send` | Sends the immutable invoice job, destination and bounded PDF |
| `GET /v1/products/pasofi/invoice-email/:providerId` | `email:read` | Retrieves the existing Resend message; cannot send another |

The caller supplies a 15-second HS256 JWT with issuer `pasofi-notification`, subject
`pasofi`, audience `onesa-email-relay:pasofi`, product, exact method/path, scope,
UUID request ID and SHA-256 of the JSON body. The relay verifies the body after
authentication and refuses other products, routes, query strings and overlong
token lifetimes. No browser or customer token is accepted.

The send body contains exactly `id` (the existing job UUID), `to`, `number`,
`filename` and canonical base64 `pdf`. It cannot choose a sender, subject, arbitrary
HTML, remote attachment URL or extra recipients. The PDF limit remains 1 MiB.
Only the existing fixed HTTPS Resend endpoint is contacted, without redirects.
The provider idempotency key remains `pasofi-invoice/<job UUID>`; there is no
replacement queue and no second idempotency namespace.

The response carries the original job/provider identity, fixed product and sender,
and the existing `submitted`, `delivered`, `failed`, `unknown` or `retry` evidence.
Provider acceptance is `submitted`; retrieval must confirm delivery. A malformed
or lost response is `unknown`. The relay and client never retry a send themselves.
Only a definite provider 429 rejection can return the existing bounded retry
instruction. Unknown jobs continue through the existing operator review path.

## Oracle connection and cutover

Use `../production/invoice-render-email.compose.yaml` **instead of** the direct
`invoice-delivery.compose.yaml` overlay. It is never added automatically by the
release launcher. Its explicit configuration is:

| Oracle variable | Purpose |
| --- | --- |
| `INVOICE_EMAIL_MODE=resend` | Retains provider identity for existing jobs |
| `INVOICE_EMAIL_TRANSPORT=render` | Selects the authenticated Render transport |
| `INVOICE_EMAIL_RELAY_URL` | Exact qualified HTTPS `*.onrender.com` origin, without a path/query/port |
| `INVOICE_EMAIL_RELAY_SECRET_FILE` | Existing protected local `invoice_email_relay_secret` file |
| `INVOICE_EMAIL_RELAY_QUALIFIED` | Records independent relay qualification |
| Existing worker/email qualification flags | Remain required independently |

Before recording a new submission, the worker reads authenticated relay
capabilities. A sleeping, disabled or unavailable relay leaves the job queued with
no attempted send. Once the send request begins, ambiguity follows the durable
`unknown` rules. Already submitted Resend IDs are polled through the new transport
without creating another invoice or email. The same provider account must remain
available for those IDs.

The runtime still uses its private `PREPAID_URL`, event inbox and notification
database. Use a separately restricted existing egress path for HTTPS to the exact
relay; never expose the database or Oracle `/internal/` routes to make it work.
The deployment administrator must retain/back up the shared secret through the
existing protected configuration process. Stop and reconcile the previous worker
before changing its transport configuration; retain unresolved job state and keys.

Qualification proceeds from exact-source tests to the disabled candidate's
revision/readiness and authorization checks. Provider-domain/account checks and
an explicitly authorized controlled-recipient delivery are separate gates. Only
after those gates pass may the reviewed runtime configuration enable delivery.
This change performs no Render deployment, provider call, email or activation.

## Availability and scope

Render's free web services sleep after 15 minutes without inbound traffic, share
750 free instance hours per workspace/month and can restart. Delivery can be
delayed while the relay wakes; free hosting is not an always-on receipt guarantee.
No keepalive schedule is introduced. A paid plan requires separate budget approval.
Free services also block SMTP ports 465/587, so this adapter uses HTTPS.

This component covers PasoFi paid invoice emails. It does not move Sendai SMS,
staff recovery SMTP or other products' notifications. Staff recovery retains its
separate TLS/REQUIRETLS and qualification requirements. The product-scoped auth
shape can be reused only after another product's sender, queue and payload contract
are independently reviewed; adding a product name alone cannot grant access.

## Verification

Run `npm test` in `services/notification-service` with a dedicated disposable test
database when integration evidence is required. New contract tests exercise the
real relay routes with a synthetic provider; the worker regression covers the
durable queued/submitting boundary, a lost provider response and retained-ID
reconciliation. No real email or production credential is used.

Validate the Blueprint against the current Render schema and, when installed,
`render blueprints validate pasofi-backend/infra/render-email/render.yaml`.
Validation does not deploy the candidate.

Current platform references: [Blueprint fields](https://render.com/docs/blueprint-spec),
[environment variables](https://render.com/docs/configure-environment-variables),
[free-service limits](https://render.com/docs/free),
[web service ports](https://render.com/docs/web-services), and
[Resend key permissions](https://resend.com/docs/api-reference/api-keys/create-api-key).
