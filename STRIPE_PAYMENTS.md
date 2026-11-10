# Stripe cards, Apple Pay and Google Pay

This integration extends the existing Pasofi checkout, order, reconciliation and
invoice ledger. It does not enable payments in any running environment. Base
production Compose still sets `PAMOFI_PAYMENTS_ENABLED=false` and
`PAMOFI_PAYMENT_MODE=disabled`.

## Payment flow and trust boundaries

1. The authenticated customer chooses a published bundle and an enabled,
   explicitly qualified sales location. The server freezes the price, currency,
   allowance and validity in the existing order. The browser supplies no amount.
2. Checkout commits one provider attempt before contacting Stripe. Its UUID is
   the Stripe idempotency key, with immutable order/customer/site metadata.
   Concurrent retries use the same attempt and PaymentIntent. An ambiguous
   initiation can be retried only within 23 hours of the original committed
   attempt, safely inside Stripe's minimum 24-hour API v1 retention. After that,
   the service preserves the unknown result for reconciliation; it never creates
   a replacement using a potentially expired Stripe idempotency key.
3. The web app mounts Stripe's Payment Element for cards. Native apps present
   Stripe PaymentSheet for cards and the available, configured platform wallet.
   Stripe owns card collection and authentication. No raw card number, CVC or
   wallet token passes through Pasofi's API.
4. Only the authenticated owner receives the original intent's client secret.
   It remains in component/native-call memory, not URLs, browser storage, database
   rows or logs. Reloading restores the original checkout key and asks the server
   for the same intent. Capacitor bridge argument logging is disabled even in
   debug builds, because its default debug logger would print native arguments.
5. `POST /callbacks/stripe` verifies Stripe's signature against the exact raw
   request bytes. A verified event is deduplicated durably and wakes the existing
   reconciliation worker. A fresh Stripe API retrieval must match the merchant,
   mode, intent, customer, order, site, method, amount and currency, and show the
   exact amount received on a paid, captured charge. A client completion screen
   cannot fulfill an order.
6. Existing transactions lock the attempt and order and issue one charge,
   entitlement and invoice. Duplicate or reordered events cannot issue another
   bundle. Refunds or disputes enter the existing reversal/review path: unused
   access can be withdrawn, while already consumed access requires review.

Only card PaymentIntents are allowed; Apple Pay and Google Pay tokenize cards
through the native SDKs. The current merchant/site eligibility is USD 0.50 through
USD 999,999.99. Stripe's account-specific limits still apply. Adding currencies or
other payment methods requires their own reviewed amount and settlement rules.

## Configuration

All values must identify the same real merchant account. The application checks
the secret key's account ID and country through Stripe before using any intent.
There is no assumed merchant country. Use the merchant account's actual supported
country, not a sample test fixture's country or the hotspot's location.

| Setting | Purpose |
|---|---|
| `PAMOFI_PAYMENT_PROVIDER=stripe` | Select this provider explicitly |
| `PAMOFI_PAYMENTS_ENABLED` | Permit **new** checkout; default remains false |
| `PAMOFI_PAYMENT_MODE=sandbox` | Only accepted in existing `APP_ENV=demo`, `NODE_ENV=development` |
| `PAMOFI_PAYMENT_MODE=production` | Only accepted in production with explicit qualification |
| `STRIPE_PRODUCTION_QUALIFIED=true` | Operator attestation after recorded test/device acceptance; credentials alone do not enable live checkout |
| `STRIPE_ACCOUNT_ID` | Exact `acct_…` merchant ID |
| `STRIPE_MERCHANT_COUNTRY` | Actual two-letter uppercase merchant country |
| `STRIPE_PUBLISHABLE_KEY` | Matching `pk_test_…` or `pk_live_…`; returned to the owning checkout |
| `STRIPE_SECRET_KEY` | Matching server-only secret key; production loads it through `STRIPE_SECRET_KEY_FILE` |
| `STRIPE_WEBHOOK_SECRET` | Endpoint-specific signing secret; production loads it through `STRIPE_WEBHOOK_SECRET_FILE` |
| `STRIPE_QUALIFIED_SITE_IDS_JSON` | Nonempty JSON array of explicitly accepted site UUIDs |
| `STRIPE_APPLE_PAY_ENABLED` | Advertise Apple Pay configuration only when true |
| `STRIPE_APPLE_PAY_MERCHANT_ID` | Provisioned Apple merchant identifier; must match the signed app's entitlement |
| `STRIPE_GOOGLE_PAY_ENABLED` | Permit the Google Pay option; SDK still checks device availability |
| `PAMOFI_STRIPE_EGRESS_SUBNET` | Required explicit, reviewed private IPv4 CIDR for the opt-in provider bridge; no automatic allocation |

Sandbox Stripe attempts use the distinct `stripe_test` ledger identity and their
invoices are marked simulated. Sandbox mode is rejected for a production ledger,
even if test credentials are present. Existing mock-only demonstration remains
available; legacy providers remain disabled.

The optional production overlay is
`pasofi-backend/infra/production/stripe-payments.compose.yaml`. It reads two private
secret files through the existing production entrypoint. Store their values using
the installation's existing protected secret custody process; never place them in
the repository, a frontend environment file, command arguments, shell history or
an artifact. Apply migration `032_stripe_payments.sql` and its reviewed runtime
grants through the existing dedicated migrator before enabling the new version.

The base application and database bridges are internal. The optional overlay adds
one external-routing bridge to `prepaid-access` only, with an explicit default
gateway priority (Compose 2.33.1 or newer). It publishes no port and leaves every
other service's networks unchanged. Before adding the overlay, compare the chosen
CIDR with **all** host routes, existing Docker subnets, site LANs and Tailscale
routes; record the non-overlap proof. Never copy a sample CIDR or let Docker choose
this network automatically. This bridge provides outbound routing, not a domain
firewall. Retain the host's reviewed egress policy and qualify DNS/TLS access from
the actual prepaid container to `api.stripe.com:443` before any test payment. The
Stripe SDK uses its fixed HTTPS API endpoint; no customer-selected URL is used.

To pause **new** payments, set `PAMOFI_PAYMENTS_ENABLED=false` while retaining the
configured provider, mode, qualification and secrets. Signed callbacks and
reconciliation remain active for existing money. Do not erase the provider
configuration as an ordinary sales pause.
The service also keeps reconciling captured money and refunds if Stripe disables
new merchant charges. Every new live intent creation separately checks the current
charge-acceptance capability. If a long provider/database outage exhausts a worker
job, a freshly verified resend of its original Stripe event revives that dead job;
ordinary duplicate delivery preserves active leases and completed jobs.

## Stripe webhook endpoint

Register the endpoint on the Oracle HTTPS API host:

`https://<actual-api-host>/callbacks/stripe`

Use **Your account** snapshot events, not Connect or organization-wide events.
Pin the endpoint to the integration's Stripe API version `2026-10-28.endive` and
subscribe to:

- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `payment_intent.processing`
- `payment_intent.canceled`
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.updated`
- `charge.dispute.closed`

Both gateway variants expose only this exact callback path for POST. The Vercel
browser API proxy does not accept arbitrary callbacks. Signature verification is
the callback's authentication; browser cookies and bearer credentials are removed
at the proxy boundary. Raw payloads are not stored. The application responds only
after the event identifier and reconciliation request commit together. Transient
Stripe or database errors return a retryable error to Stripe.

## Native provisioning and acceptance

The app identifier remains `com.onesa.pasofi`. See
`pasofi-frontend/mobile/NATIVE_BUILDS.md` for the exact SDK pins, return URL,
entitlement/build setting and native signing requirements added with this change.
The apps also require the separately qualified [native customer connection](NATIVE_CUSTOMER_CONNECTION.md)
through the public Vercel proxy. Its private cookie and session-retry transport is
implemented behind default-off deployment gates; merchant credentials alone do
not enable it. A true mobile capability records configured proxy qualification,
not proof of the current device's session or wallet acceptance.

Apple's account owner or an authorized developer must provision the actual
merchant ID, create/upload the Stripe payment processing certificate, enable
Apple Pay for the app identifier and regenerate the signing profile. These are
merchant/developer account operations; a source build does not perform them.

Google Pay production use needs the merchant's approved Google Pay configuration
and a properly signed release app. The native SDK uses its test environment for
Stripe test checkout and its production environment only for qualified live
checkout. Device and supported-card availability determine whether a wallet is
shown. Card fallback remains available when the wallet cannot be used.

## Required acceptance record before live activation

Use an isolated demo database, Stripe test keys and a test endpoint signing secret.
Record the source commit, Stripe test account ID, site IDs, native app build IDs
and the test event/intent identifiers. Do not include client secrets or raw events
in the record.

- Web card success, decline, 3DS success/cancellation, reload and lost checkout
  response; the original intent/key must be reused.
- iPhone Apple Pay success/cancellation and unavailable-wallet card fallback,
  using the actual provisioned merchant ID and signed app.
- Android Google Pay test success/cancellation and unavailable-wallet card
  fallback, using the actual signed app and merchant country.
- A client success callback before webhook processing must show unconfirmed
  payment and no usable bundle.
- Duplicate and out-of-order webhook delivery, stale/invalid signature, wrong
  merchant/mode/customer/order/amount/currency, and provider/database timeouts.
- An accepted webhook whose worker exhausts retries, followed by resending the
  same event after recovery; verify one fulfillment. Restrict new merchant charges
  in a synthetic test and confirm existing captured money/refunds still reconcile.
- Confirm the reviewed egress CIDR overlaps no host/Docker/site/Tailscale route,
  DNS and HTTPS work from prepaid, no additional service gained provider egress,
  and the base configuration stays closed when the optional overlay is absent.
- Complete checkout from an actual unpaid HotSpot guest, including Stripe.js or
  native Stripe endpoints and the card issuer's 3DS/SCA challenge and return path.
  Backend egress does not prove that a captive customer can reach those services.
  If the supported flow uses another available internet connection, document and
  test that customer path explicitly. Any exact router walled-garden exception
  requires its own qualification; this change does not broaden router access.
- Exactly one entitlement and invoice after verified payment; test invoice marked
  simulated. Existing voucher, cash, session and quota behavior remains intact.
- Refund/dispute of unused access and review of consumed access. Verify that
  pausing new payments retains callbacks/status/reconciliation.
- Inspect device and service logs for absence of keys, client secrets, raw events
  and card data; verify the native customer-cookie transport is already qualified.

Automated tests use synthetic provider responses and isolated database/browser
fixtures. They do not claim merchant enrollment, a real wallet authorization or a
live charge. No live transaction is part of implementation or CI.

## Primary integration references

- [Docker Compose default-gateway priority](https://docs.docker.com/reference/compose-file/services/#gw_priority)
- [Stripe PaymentIntents](https://docs.stripe.com/payments/payment-intents)
- [Stripe API idempotency retention](https://docs.stripe.com/api/idempotent_requests)
- [Stripe webhook signatures, retries and ordering](https://docs.stripe.com/webhooks)
- [Stripe.js Content Security Policy](https://docs.stripe.com/security/guide)
- [Stripe native PaymentSheet](https://docs.stripe.com/payments/mobile/accept-payment)
- [Apple Pay provisioning](https://developer.apple.com/help/account/capabilities/configure-apple-pay)
- [Google Pay Android production readiness](https://developers.google.com/pay/api/android/guides/test-and-deploy/integration-checklist)
