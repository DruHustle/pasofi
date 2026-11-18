# EcoCash SMS-assisted merchant pilot — API pending

**Status: controlled manual reconciliation design; not activated for live automated vouchers.** This is distinct from cash sales, and does not create a provider integration or declare the merchant account ready. The customer-facing dual-path EcoCash UI remains provider-gated until real settlement acceptance.

## Intended temporary journey

1. Customer selects the published PasoFi bundle and site; the system quotes an immutable amount/currency and shows a unique customer payment reference. Do not show an EcoCash merchant code that has not been formally approved.
2. Customer pays the *approved* PasoFi EcoCash merchant through their EcoCash app or USSD. **An SMS received on the merchant-controlled phone is a notification, not payment proof**. Do not use the customer's screenshot, text message, forwarded SMS, phone number or typed reference as authority.
3. An authorized agent collects the claimed reference and records a **pending mobile-money verification**. A second authorized approver or merchant treasury operator independently verifies **in the official merchant app/statement** that the transaction was settled, not reversed, intended for the correct merchant, has the exact currency and amount, and has a unique provider transaction ID not used for any previous sale.
4. The backend must atomically record an immutable `ecocash_manual_verified` tender and the voucher with a unique provider transaction reference, purchase site, verifier identity, matching bundle quote and separation from the cash shift. Double-submit must return the same result; contradictory attempts, reversed transactions, duplicate references and mismatched amounts go to a review queue.
5. The customer gets the one-time private voucher over a separately qualified SMS delivery service or in an authenticated receipt. Do not rely on a manual screenshot for voucher delivery. Redemption is customer-bound when paired and network-accessible only after the real K0/G0 HotSpot/RADIUS session is qualified.
6. Reconcile the merchant statement daily against issued vouchers, refunded/voided transactions, unsettled claims and cash shifts. Any reversal must trigger protected review, entitlement revocation and network disconnect where supported, with dual authorization for refunds.

## Existing software vs incomplete functionality

- **Available:** Staff cash stock/shift, exact amount attestation, one-use voucher and private receipt; distinct provider gateways; sandbox-only EcoCash credit simulation; SMS delivery worker capability flags.
- **Not available as a production path:** Reading and authenticating merchant phone SMS, verifying actual EcoCash settlement, issuing an independently audited `ecocash_manual_verified` voucher, or reconciling incoming merchant credits against official provider statements. Do not forge a cash attestation or send an unverified payment through the cash sales endpoint.
- **Implementation gate:** Obtain approved merchant code/settlement currency; provider-supported merchant app/statement access for an independent operator and a safe way to cite the immutable provider transaction ID. Design the independent approval/ledger flow with server-side idempotency and role/site scope. A provider SMS alone is never sufficient for automatic fulfillment.
- **Activation gate:** One supervised small real merchant transfer plus official independent statement confirmation, one verified voucher, one delivered SMS/receipt, one redeem, metered HTTPS HotSpot/RADIUS session and reversal/refund exercise, all logged against the exact deployment.

## Cash service launch (independent)

For initial paying customers, use the **cash-only** path already implemented in the prepaid-access backend. The agent must be approved and site-scoped, have an open shift and allocated voucher stock, explicitly attest exact physical cash received and issue a receipt. Customer access requires actual functioning K0/G0 physical authentication, accounting and quota disconnection. See [cash commissioning](CASH_HOTSPOT_LAUNCH.md).

## Native Apple Pay and Google Pay

Native Apple Pay and Google Pay are supplied by the Stripe PaymentSheet bridge, **not** by EcoCash SMS. Both can be tested against Stripe sandbox but cannot take real payments until a live Stripe merchant account, publishable key, signed webhook/settlement verification, wallet domain/merchant configuration, actual signed iOS/Android builds, entitlement/refund safeguards and live acceptance are in place. Do not turn on live payments based on a green unsigned simulator build.
