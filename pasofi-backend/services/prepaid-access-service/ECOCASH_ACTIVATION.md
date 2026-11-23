# EcoCash checkout: activation guide

**State:** built, tested with synthetic EcoCash responses, **switched off**. No environment runs it. Activate only after EcoCash issues API access and every step below passes.

This covers the **Pay in PasoFi** journey: the customer picks a bundle, enters their own EcoCash number, and approves the charge on their phone. The separate **Pay Merchant / USSD → voucher SMS** journey ([DIRECT_PAYMENTS.md](DIRECT_PAYMENTS.md)) keeps its own path and switch.

## How it works

1. The customer chooses **EcoCash** and enters their wallet number. PasoFi never asks for the PIN.
2. In one database transaction the service creates the payment attempt and stores the number sealed with AES-256-GCM (`ecocash_checkout_contexts`). Only the last three digits stay readable, for the customer's own screen.
3. The service sends **one** charge request (`POST …/transactions/amount/`). The correlator is the attempt UUID. The request is never sent again, even if the response is lost.
4. The customer approves the prompt on their phone. The web and mobile apps show "Approve on your phone".
5. The reconciliation worker polls the read-only lookup (`GET …/{number}/transactions/amount/{correlator}`) with backoff: 10 tries, from 5 s up to 5 min apart.
6. The order is fulfilled **only** when the lookup returns `Charged` with `responseCode 00`, the identities match, and EcoCash's own **charged amount, currency and merchant code** match the stored order. Then one entitlement and one invoice are issued. Duplicate or concurrent lookups are harmless.
7. Anything else (still pending, missing fields, a different amount or merchant) is left unverified. It is never fulfilled and never marked failed on a guess.

Sandbox attempts use the `ecocash_test` ledger identity and their invoices are marked simulated. Live attempts use `ecocash`.

## Switches and settings

New EcoCash checkout opens only when **every** row holds. If any one is missing, checkout stays closed and the public `ecocashCheckout` capability stays `false`.

| Setting | Required value |
|---|---|
| `PAMOFI_ECOCASH_CHECKOUT_ENABLED` | `true`. This is the journey's own switch and defaults to `false`. |
| `PAMOFI_PAYMENTS_ENABLED` | `true`. This is the global new-payments switch; setting it `false` pauses new sales without stopping reconciliation. |
| `ECOCASH_ENVIRONMENT` | `production`. `sandbox` is accepted only with `APP_ENV=demo` and `NODE_ENV=development`. |
| `APP_ENV`, `NODE_ENV`, `PAMOFI_PAYMENT_MODE` | All `production`. |
| `ECOCASH_PRODUCTION_QUALIFIED` | `true`, set only after the qualification below is recorded. |
| `ECOCASH_API_BASE_URL` | The production base URL EcoCash issues at go-live: HTTPS, no credentials, no query, ending in `/`. The sandbox host is refused. |
| `ECOCASH_API_USERNAME`, `ECOCASH_API_PASSWORD_FILE` | Basic-auth credentials. The password is loaded from a protected secret file. |
| `ECOCASH_MERCHANT_CODE`, `ECOCASH_MERCHANT_NUMBER`, `ECOCASH_TERMINAL_ID`, `ECOCASH_LOCATION`, `ECOCASH_SUPER_MERCHANT_NAME`, `ECOCASH_MERCHANT_NAME` | Exactly as EcoCash registered them. |
| `ECOCASH_MERCHANT_PIN_FILE` | The merchant PIN from a protected secret file. This is never a customer PIN. |
| `ECOCASH_QUALIFIED_SITE_IDS_JSON` | A non-empty JSON array of site UUIDs that passed acceptance. An empty list keeps reconciliation running but sells nothing. |
| `VOUCHER_DELIVERY_ACTIVE_KEY_ID`, `VOUCHER_DELIVERY_KEYS_JSON` | The existing sealing keys, which also seal payer numbers. |
| `PAMOFI_CUSTOMER_NETWORK_ENABLED`, `PAMOFI_RADIUS_QUALIFIED`, `PAMOFI_ROUTER_CONTROL_QUALIFIED` | All `true`: the same physical gates Stripe needs. |
| `PAMOFI_PAYMENT_PROVIDER` | Unset, `mock` (demo only) or `stripe`. Any other value, including `ecocash`, disables all checkout. |

Deploy with `infra/production/ecocash-payments.compose.yaml` on top of the existing files. Like the Stripe overlay, it adds one outbound-only network for `prepaid-access`. Choose `PAMOFI_ECOCASH_EGRESS_SUBNET` only after checking it doesn't overlap host routes, Docker subnets, site LANs or Tailscale routes. Apply migration `036_ecocash_checkout.sql` and the updated `role-policies.json` grants through the existing migrator first.

When credentials are configured but the switch is off, the service still reconciles existing EcoCash attempts using read-only lookups. It never sends a new charge.

Production prepaid startup requires the password and merchant PIN through their protected secret files when checkout is requested. Inline password and PIN settings prevent startup even when checkout is paused.

## What to ask EcoCash for

1. Merchant registration approval and **sandbox credentials**: username, password, merchant code, merchant number, terminal ID, registered names and location, and test customer numbers.
2. Confirmation of the lookup response fields that prove settlement. PasoFi reads `paymentAmount.totalAmountCharged`, or else `paymentAmount.charginginformation.amount`, plus `charginginformation.currency` and `merchantCode`. **If the lookup doesn't return these, the payment can't be fulfilled automatically.** In that case ask EcoCash for a merchant transaction or statement feed, and adapt `check()` in `src/ecocash-checkout.ts` to read it.
3. The exact pending and failure status values (for example declined, insufficient funds, timeout or cancelled), so terminal failures can be mapped. Today any non-`Charged` status stays unverified.
4. The accepted correlator format. PasoFi sends a UUID; confirm EcoCash accepts it.
5. Refund and reversal procedure and responses.
6. Whether an authenticated callback (`notifyUrl`) is offered, with its signature and replay rules. PasoFi doesn't send `notifyUrl` today; polling is the only path.
7. The production base URL and production credentials after the Go Live review.

## Qualification, with sandbox credentials (demo environment)

Record the evidence for each test, then set `ECOCASH_PRODUCTION_QUALIFIED=true`. In demo, set `ECOCASH_ENVIRONMENT=sandbox` with the sandbox credentials. No live money moves.

| ID | Test | Pass |
|---|---|---|
| ECO-Q1 | Successful charge on a test number, approved on the handset | One entitlement, one simulated invoice, lookup fields as expected |
| ECO-Q2 | Customer declines the prompt | Nothing granted; record the status EcoCash returns |
| ECO-Q3 | Insufficient funds | Nothing granted; record the status |
| ECO-Q4 | Customer ignores the prompt (timeout) | Nothing granted; attempt left for review |
| ECO-Q5 | Network drop during the POST (block egress mid-request) | No second POST; lookup recovers the real outcome |
| ECO-Q6 | Wrong amount or merchant in the lookup (if EcoCash's sandbox can produce it) | Not fulfilled |
| ECO-Q7 | Refund of a test charge through EcoCash's procedure | Refund recorded; unused access withdrawn through the existing reversal review |
| ECO-Q8 | Web, iOS and Android on a real phone: number entry, approval screen, verified status | Customer sees "Approve on your phone" and is queued only after verification |
| ECO-Q9 | Supervised live charge at one qualified site, at the smallest bundle price, with owner approval | Real internet access delivered and accounted |

## Automated tests

- `test/ecocash-checkout.test.mjs`: the default-off state, every activation gate on its own, provider-selector typos, payer-number validation, and settlement parsing.
- `test/ecocash-checkout.integration.test.mjs` (disposable PostgreSQL): the context is committed before the single POST, lost responses, no re-POST, fulfilling exactly once, mismatched amount, currency, merchant or reference, and worker isolation.
- `pasofi-frontend/web/tests/ecocash-checkout.spec.ts`: number entry, no PIN field, the approval state, and server-verified status only.

All of these use synthetic responses. They are evidence level E2/E3 and don't prove EcoCash's real API behaves the same way.
