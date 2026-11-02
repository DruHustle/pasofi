# prepaid-access-service

Independent build: `npm ci && npm run build`. Set `DATABASE_URL` to this service's database before `npm start`. `npm test` runs integration tests when `PAMOFI_TEST_DATABASE_URL` points to an isolated database. The outbox case also requires `PAMOFI_TEST_NOTIFICATION_DATABASE_URL` and `PAMOFI_TEST_NOTIFICATION_URL`; run worker tests serially because they claim service-wide queues. A skipped integration case is not an acceptance pass. Source and synthetic tests do not establish deployed provider/router qualification; see `../../docs/BUILD_STATUS.md`.

Apply owned migrations as a separate release step with `DATABASE_URL=... npm run migrate`. The database user must have migration privileges. This local-demo setup does not yet separate runtime and migration roles.

The outbox dispatcher is disabled by default. To run it, configure `OUTBOX_DISPATCH_ENABLED=true`, `NOTIFICATION_URL` and a separate `INTERNAL_EVENTS_SECRET` of at least 32 bytes. Non-demo operation requires HTTPS and rejects the example secret. It retries with a bounded lease and backoff. The notification consumer records a reference-only job, resolves its details through the authenticated delivery boundary, and uses only its explicitly configured mock or qualified Sendai mode. No phone number or voucher enters the outbox payload.

Provider checkout, callbacks and reconciliation are disabled by default. The mock provider requires `PAMOFI_PAYMENTS_ENABLED=true`, `PAMOFI_PAYMENT_MODE=mock`, `APP_ENV=demo` and `NODE_ENV=development`; it makes no payment HTTP request or real charge. Real sandbox mode additionally requires `PAMOFI_PAYMENT_MODE=sandbox` and `PESEPAY_SANDBOX_QUALIFIED=true`. Production mode requires `PAMOFI_PAYMENT_MODE=production`, `APP_ENV=production`, `NODE_ENV=production` and `PESEPAY_PRODUCTION_QUALIFIED=true`. These flags record an external qualification decision and do not prove that qualification occurred.

Real modes require `PESEPAY_INTEGRATION_KEY`, `PESEPAY_ENCRYPTION_KEY`, `PESEPAY_APPLICATION_ID`, HTTPS `PESEPAY_RESULT_URL`/`PESEPAY_RETURN_URL`, comma-separated HTTPS `PESEPAY_CHECKOUT_ORIGINS`, `PESEPAY_METHODS_JSON`, comma-separated `PESEPAY_MERCHANT_METHOD_CODES`, and `PESEPAY_SITE_METHOD_CODES_JSON` mapping site UUIDs to method codes. The result URL is `/callbacks/pesepay`. Methods are checked against authoritative bundle terms, currency, amount bounds, merchant activation and site qualification. The callback is only a hint: fulfillment requires a matched server-to-server status check. Initiated attempts are queued independently of callbacks. The legacy demo-only sandbox callback flag remains supported when the new checkout path is not enabled. Never put credentials in source control or request logs.

The worker uses database leases and retries pending or unverifiable checks with bounded backoff. A job marked `dead` needs operator investigation; a new authenticated callback will re-arm it. Inspect `payment_reconciliation_jobs` and `payment_reviews` without displaying credentials. Automated tests have not activated live Pesepay. Keep production payments disabled until provider qualification, monitoring and operations are in place.


## Reconciliation and customer history

Payment review outcomes remain attached to the exact provider charge on retries. A duplicate charge never reports an entitlement it did not create, and a consumed-access reversal remains pending review. A verified reversal observed before success is recorded without granting access; an older success response cannot undo it. A reference conflict also blocks another initiation for that order until investigation. Only the adapter's explicit `verified_success` result can fulfill an order.

`GET /v1/access` shows active access first, the usable FIFO queue next, and historical purchases afterward. Optional `limit` (1–100, default 100) and `offset` (0–1,000,000, default 0) paginate the authenticated customer's records; `hasMore` and `nextOffset` indicate another page. All service responses use `Cache-Control: no-store` so customer history, entitlement data and internal authority responses are not cached.


If a provider initiation returns a valid reference but a missing or untrusted checkout URL, the attempt remains uncertain and exposes no redirect. The reference is retained and a verification job is scheduled so the payment can be reconciled without initiating a second charge.

Idle PostgreSQL connection failures are handled without terminating the process; readiness still depends on a successful database query. SIGTERM and SIGINT close the HTTP server, stop dispatch timers, await in-flight work, and close pools. A 10-second shutdown deadline prevents an indefinitely stalled stop.

## Staff commerce and private receipts

Commerce requires `PAMOFI_COMMERCE_ENABLED=true`, a valid delivery keyring and configured identity service authority. Every staff request resolves its current approved role, site scopes and MFA-completed session from identity. The browser never supplies an authoritative actor, role, price or commission. Admins create sites, publish immutable bundle versions and allocate stock. Agents sell only their own inventory at assigned sites. Support can inspect scoped sale/delivery history but cannot sell, reveal vouchers or resend them.

| Route | Contract |
| --- | --- |
| `GET /v1/capabilities` | Explicit feature booleans, payment mode and demo flag; `deliverySms` checks the notification capability/mode, `networkAccess` shares the network route gate, `mobileCookies` remains false. |
| `GET /v1/sites`, `GET /v1/staff/sites` | Active commercial locations; the staff list is scope-filtered. Creating a location does not configure a router. |
| `POST /v1/admin/sites` | Idempotent creation by body UUID or UUID `Idempotency-Key`. |
| `GET/POST /v1/admin/bundles` | Inspect all versions or create immutable terms with a reason. |
| `PATCH /v1/admin/bundles/:id` | Publication and reason only. Change price/data/validity by creating a new version ID. |
| `GET /v1/staff/inventory` | Agent/site/bundle quantities. |
| `POST /v1/admin/inventory/allocations` | Approved target agent/site validation, one atomic stock increase and audit per admin idempotency key. |
| `POST /v1/staff/sales` | UUID idempotency key and `{siteId,bundleId,delivery,pairingCode?,phone?}`. One stock debit, sale snapshot, voucher and outbox event commit together. |
| `GET /v1/staff/sales` | Scoped history with `limit`, `offset`, `hasMore`, `nextOffset`. |
| `GET /v1/staff/sales/:id/receipt` | Private receipt for the owning agent or administrator. Ordinary sale responses omit the voucher. |
| `GET /v1/staff/sales/:id/delivery`, `POST /v1/staff/sales/:id/resend` | Sanitized delivery status and explicit idempotent resend to the same saved recipient. Unknown delivery remains blocked. |

All prices are integer minor units. `PAMOFI_AGENT_COMMISSION_BPS` defaults to zero and accepts 0–10000. Sales permanently snapshot price, currency, allowance, validity, site name and commission rate/amount. Allocation/resend reasons require 10–500 characters. Retry an uncertain sale with the same UUID key and immutable request; its committed response remains recoverable during a later delivery outage.

Customers create `POST /v1/receipt-pairings` with an idempotency key and show the random ten-character, five-minute code to an agent. Receipt or combined receipt/SMS sales consume the code atomically. Only the paired account can retrieve `GET /v1/receipt-pairings/:id` or redeem that voucher. SMS-only vouchers remain bearer codes, redeemable once into a customer account. Both delivery channels share the same voucher and at most one entitlement. `POST /v1/vouchers/redeem` requires a customer session, exact origin and rate limit; repeating a successful redemption by its owner returns the same entitlement. Redemption queues access without starting validity or connecting a device. Voucher/pairing codes never belong in query strings or request logs.

Configure `VOUCHER_DELIVERY_ACTIVE_KEY_ID` and `VOUCHER_DELIVERY_KEYS_JSON`, a JSON object mapping short key IDs to base64-encoded 32-byte AES keys. AES-256-GCM binds encrypted voucher codes, phone payloads and pairing codes to their record context. Each record stores its key ID. Rotation adds a new key and switches the active ID while retaining old keys needed for outstanding vouchers/receipts. Removing an old key makes those deliveries unavailable. No key is created or enabled by default.

Notification obtains transient message details from `GET /internal/v1/deliveries/:id` using a short-lived JWT with issuer/subject `notification`, audience `prepaid-access`, scope `delivery:read`, and separate `INTERNAL_DELIVERY_SECRET` of at least 32 bytes. Set `PAMOFI_SMS_DELIVERY_ENABLED=true` alongside `OUTBOX_DISPATCH_ENABLED=true`, a valid event secret, and the compatible notification worker; SMS is unavailable without that complete dispatch path. HTTPS is required outside demo/development. Sendai remains separately qualified and disabled by default.

## Quote status and browser boundaries

`POST /v1/orders` accepts `{bundleId,mode:'demo'|'checkout'}`. Demo is the backward-compatible default and unavailable outside demo/development. Checkout requires explicit provider enablement. Idempotency binds the bundle and mode; checkout orders cannot use demo-confirm. `GET /v1/payments/methods` filters for an active location/published bundle; `POST /v1/orders/:id/checkout` verifies ownership, origin and a UUID idempotency key.

`GET /v1/orders/:id/status` reports `fulfillmentState` (`unconfirmed`, `fulfilled`, `reversed`, `pending_review`) and `entitlementRevokedAt`. Revoked entitlements have a null `entitlementId`. Historical `payment_confirmed` alone is not current fulfillment evidence. A consumed reversal or duplicate charge remains under review. Mock success/failure/reversal exercises the same reconciliation domain without a provider charge.

An expired quote can be safely replaced only after `POST /v1/orders/:id/expire-unused` with `{}` returns `{orderId,state:'expired_unused',safeToRequote:true,replayed}`. This customer-owned, origin-checked action locks the order against initiation, checks expiry using the server clock, rejects any prior payment attempt, charge or entitlement, and writes a durable fence. Its owned order ID is the idempotency identity. An initiating, unknown, pending or even failed attempt prevents this disposal path. The database also prevents a later attempt from an older process. Status reports `safeToRequote:true` and `order.expired_unused_at` only after committed closure; client-clock expiry alone never permits abandoning a payment intent. Apply migration `023_quote_expiry.sql` before this application version.

Rate-limit routes register after the Fastify plugin so their declared limits execute. `PAMOFI_TRUST_PROXY_CIDRS` defaults to empty, ignoring forwarded IP headers. Behind a controlled gateway, configure only exact private proxy IPs/CIDRs; wildcard trust, named ranges and `/0` are rejected. The public gateway must overwrite incoming `X-Forwarded-For` with its observed client address; trusted intermediate proxies may preserve that verified chain.

## Network reservations and operator review

Customer network access requires `PAMOFI_CUSTOMER_NETWORK_ENABLED=true`, `NETWORK_URL`, separate `INTERNAL_NETWORK_SECRET` (at least 32 bytes), and `INTERNAL_RADIUS_ENABLED=true` in demo or `PAMOFI_RADIUS_QUALIFIED=true` outside it. HTTPS is required outside demo. Network independently enforces its own gate and encrypted credential configuration. Customer routes are `/v1/network/sites`, `/session`, `/credentials` and `/disconnect` under the same prefix. A successful payment or queued entitlement is not connection evidence. Disconnect requests retain the reservation until accounting and independent router evidence permit closure.

MFA-verified administrators can list `GET /v1/admin/network/reviews` and resolve `POST /v1/admin/network/reviews/:id/resolve` using a UUID idempotency key, `expectedVersion`, decimal-string `finalUpload`/`finalDownload`, reason and evidence reference (10–500 characters). Resolution locks the customer and grant, requires fresh independent absence after the latest accounting/late-usage event plus credential fencing, and rejects another live reservation. Final counters must include all high-water/late-usage evidence and fit the existing reservation and entitlement. Only the additional verified bytes are charged; one append-only audit records the decision, and only that grant's account hold is cleared. Unknown usage cannot be guessed, written off or charged in full automatically. Periodic absence refresh does not invalidate an otherwise unchanged review version; new accounting/state changes do.
