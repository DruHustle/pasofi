# EcoCash two-journey merchant activation and acceptance

**Status:** Integration prepared, not live. This document is a handoff for the PasoFi operator and EcoCash merchant/developer support. It is not a production approval or a credential request in a public repository.

## Customer journeys

1. **In-app EcoCash checkout (Online Payments):** Customer selects a published PasoFi bundle/site on Web, iOS or Android, supplies their own mobile money number, approves the merchant-initiated transaction, and returns to a pending order. The server stores an immutable order and attempt before initiation, performs read-only recovery after an uncertain initiation, and fulfills only with independently verified settlement evidence bound to the order, merchant, amount, currency and payer. A UI approval or provider's bare `Charged` response is insufficient.
2. **Direct Pay Merchant (USSD or EcoCash app):** Customer selects an advertised *unique exact amount*, pays an approved PasoFi merchant code without starting an online checkout, and receives a one-time Wi-Fi voucher by SMS to the verified payer number after EcoCash confirms an incoming settled credit. The voucher may be passed to another user and redeemed once. Never accept an SMS screenshot or user-submitted reference as settlement evidence.

Both journeys share the authorized bundle catalogue, voucher rules and site-independent entitlement, but **do not share payment transaction IDs or activation switches**. A direct merchant credit must never complete an unrelated initiated checkout order.

## Information the operator must obtain from EcoCash

- Legal merchant registration, approved merchant code/number and commercial settlement currency; supported site and transaction limits.
- Sandbox and production API credentials via protected secret injection, API documentation version, provider test numbers and confirmed callback URLs.
- For Online Payments: whether a lookup or authoritative statement proves **actual amount, currency, destination merchant, original order reference, payer, final status, reversal and refund**. The public response example lacks several settlement fields. Request a signed provider settlement statement or contract before auto-fulfillment.
- For Pay Merchant: authenticated merchant-originated credit notifications or a read-only transaction feed for **customer-initiated** app/USSD merchant transfers, including merchant identity, payer number, immutable transaction ID, payment time, currency, settled amount, state, and reversal event.
- Webhook signature algorithm and canonicalization, key rotation, time tolerance, replay/duplicate semantics, missed-notification recovery, event ordering, recovery pagination/rate limits, sandbox and production endpoint hosts.
- Refund/reversal eligibility and reconciliation terms; SMS sender identity and permitted transactional message template.
- Written approval for live merchant collection, sending transactional SMS and permitted currency.

Store secrets **only** in protected runtime configuration. Do not commit wallet PINs, merchant PINs, API keys, sender credentials, real customer data or router exports.

## Required test matrix (run separately for each journey)

| Test | Expected outcome |
| --- | --- |
| Genuine successful test payment | One *verified* funding record; one voucher or entitled order, never more |
| Replayed notification, 10+ concurrent duplicates | Same funding identity; no additional voucher or SMS |
| Lost initiation response | Original correlation recovered read-only; no repeat charge |
| Pending, declined, failed and ambiguous result | No voucher or network access; explicit recoverable status |
| Wrong merchant, wrong currency, amount mismatch, missing payer | Hold for review; no automatic fulfillment |
| Two bundles with same Pay Merchant price | Ambiguous credit held; require unique published amount or reference |
| Late notification after price or bundle withdrawal | Historical offer evaluated at payment time, with review for unavailable catalogue |
| Reversal before original notification | No voucher, including if original arrives late |
| Reversal after voucher redemption/usage | Revoke/fence entitlement, stop/resync network and flag operator review |
| SMS unavailable or unknown provider outcome | Voucher remains durable; no blind second send; controlled audited recovery |
| Account/login expiry and device switch | Order/receipt recovery preserves owner, no duplicate charge |
| K1/G1/G2/G3 participating hotspot test | One purchased bundle redeemed and enforced by actual RADIUS session, with byte accounting and disconnect |
| Real iOS/Android and web | Installed release builds exercise payment, recovery, receipt and redemption |

The current local EcoCash tests use **synthetic** credits and SMS only. They do not prove provider integration or a physical hotspot session.

## Activation procedure

1. **Operator:** Finish merchant registration; gather the written contract and approved merchant code. Redact credentials before sharing technical payload examples.
2. **Engineering:** Implement the provider-specific authenticated adapter and reconciliation against those concrete examples, with immutable transaction and order ledgers. Keep both switches disabled.
3. **Engineering + EcoCash:** Run provider sandbox cases including callbacks, missed events and reversals; preserve redacted observations and source SHA.
4. **Operations:** Qualify transactional SMS, customer support, refund handling, Oracle network services, RADIUS and physical router sessions at each active site. Prove backup/restore and alerts.
5. **Release lead:** Approve each path and site independently based on actual live-payment, SMS, voucher redemption, connected internet and accounting evidence. Enable only the approved method; monitor and retain rollback controls.

**No-go triggers:** Missing authoritative settlement proof, no incoming merchant feed for Pay Merchant, uncertain reversal semantics, unqualified SMS, unsafe router enrollment, failed CI, or no physical-network acceptance.

Official references: [Online Payments](https://developers.ecocash.co.zw/docs/online-payments), [EcoCash merchant onboarding](https://ecocash.co.zw/merchants/), [Go Live](https://developers.ecocash.co.zw/docs/go-live).
