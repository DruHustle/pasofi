# Direct payment preparation

EcoCash sources were rechecked on 2026-11-17. Direct mobile money is pending. Cash sales and the separately gated [Stripe checkout](../../../STRIPE_PAYMENTS.md) have their own fulfillment paths.

## Bank and Zimswitch selection

The [payment investigation](../../docs/PAYMENT_INTEGRATION_RESEARCH_2026-11-02.md) now compares Stanbic, CBZ/iVeri, CABS and ZB/Smile&Pay, with current-source dates and pricing limitations. Stanbic is the first commercial candidate for online Visa/Mastercard, CBZ provides a strong documented integration alternative, CABS must confirm its online acquiring offer, and ZB is a candidate for combined cards and wallets. No bank has been selected or merchant account approved by this work.

Zimswitch is a payment network and online-gateway route onboarded through an acquiring bank. CABS card issuing and physical POS support do not prove online merchant Visa/Mastercard acceptance. Pasofi requires the actual merchant contract, enabled card brands/currencies, settlement arrangement, sandbox and authenticated verification/refund specification before implementing that bank's adapter. Published customer/account charges are not merchant commission, and no tariff is an application constant.

`paymentConfiguration` enables only explicit demo-mode simulation: `PAMOFI_PAYMENTS_ENABLED=true`, `PAMOFI_PAYMENT_MODE=mock`, and the application's demo/development environment checks. `PAMOFI_PAYMENT_PROVIDER` may be absent for existing demo configurations or exactly `mock`. Any other explicit value, including an empty or misspelled value, disables checkout; naming an unsupported bank/provider must not silently select a mock payment. Production remains disabled even with an explicit mock selector.

The gate regression checks cover Pesepay, EcoCash, InnBucks, Stanbic, CBZ, ZB, CABS and Zimswitch across unsupported sandbox/production modes and attempted mock fallback. They assert disabled public capabilities, unavailable checkout/callback routes, and no outbound HTTP calls. These are local boundary tests; they do not certify a bank integration or enable a digital payment method.

## Incoming EcoCash transfers for Wi-Fi vouchers

A customer should be able to pay the PasoFi merchant from their EcoCash app or USSD menu and receive a voucher by SMS without first opening PasoFi. For this flow, choose one exact USD price for each offer advertised on the merchant account. A customer sending for somebody else receives the code on the paying phone and can pass it on. The code can be redeemed once.

### What EcoCash needs to provide

EcoCash describes handset confirmations for ordinary Send Money. The recipient's documented confirmation includes the amount, sender name and approval code. The merchant channel separately describes a confirmation with the paying number. As of 2026-11-17 the public API catalogue lists BillPay (EPG Push) as coming soon. A merchant SMS by itself does not establish a server integration. [Send Money](https://ecocash.co.zw/ecocash-send-money/) · [Merchant terms, section 3.4](https://partnerapplications.ecocash.co.zw/terms-and-conditions) · [API catalogue](https://developers.ecocash.co.zw/)

When applying for the merchant code, ask EcoCash specifically for incoming **customer-initiated** payments from USSD and the app. Request authenticated notifications or an authoritative merchant transaction feed, the reconciliation and reversal procedures, and test credentials. Ask for examples identifying the destination merchant, original transaction ID, payer's SMS-capable number, settled amount, currency, status and original payment time. Obtain their retry, authentication and replay contract and confirm how to recover missed events. [Merchant application](https://ecocash.co.zw/merchants/) · [Contact EcoCash](https://ecocash.co.zw/contact-us/)

The documented Online Payments charge below offers a separate journey. A PasoFi checkout would select the bundle, request a charge, and the customer would approve on their phone. Its lookup takes the customer number and the correlator generated for that charge. It cannot enumerate transfers made independently to the merchant. [Online Payments](https://developers.ecocash.co.zw/docs/online-payments)

### Implemented behavior

The prepaid service records each simulated incoming credit under the receiving merchant and original transaction ID. It checks the price and currency against an explicitly configured offer active at the payment time, verifies that the published bundle still matches its quoted allowance and validity, and uses the payer number on the credit for delivery. The credit, encrypted voucher and delivery event commit together. Notification resolves the phone and voucher privately from prepaid and sends through the mock SMS worker. The existing voucher redemption screen accepts the code in demo. One successful redemption creates one entitlement.

| Observation | Outcome |
| --- | --- |
| Same credit delivered twice, including concurrently | One voucher and one initial delivery job |
| Amount has no matching offer, or two bundles match | Credit retained for review, with the reason |
| Missing payer number, unsupported currency, changed catalogue terms or expired start window | Credit retained for review |
| Payment addressed to another merchant | Ignored by this merchant configuration |
| Same reference with conflicting payment details | Original details preserved, voucher held and any redeemed access fenced |
| Reversal before the credit, before redemption or after redemption | Original reference remains closed. An unused code stops working. A redeemed entitlement is revoked. Evidence of use is flagged for review. |

### Run the simulated journey

Run the existing five-database integration gate from the repository root, following the disposable setup in [Testing PasoFi](../../docs/TESTING.md). It exercises a synthetic transfer, a repeated notification, private SMS resolution, delivery to the mock SMS sink, a customer session, repeat redemption and the account's resulting allowance.

```sh
node pasofi-backend/local-tools/verify.mjs --integration --browser
```

The input fixture lives at `test/fixtures/ecocash-credit.mjs` in the prepaid service and reads a JSON object with `config` and `observation` from standard input. The executable example is in `test/ecocash-workflow.integration.test.mjs`. The fixture uses demo/development, a disposable loopback prepaid database, an explicit isolation acknowledgement and demo delivery keys. Its output contains the credit ID and outcome. It accepts no network callbacks. Its record shape is local to PasoFi and is not an EcoCash payload specification.

Production activation requires an adapter for the contract EcoCash supplies, provider-certified samples including reversals, a qualified SMS sender and a supervised payment through voucher redemption and hotspot access. The simulation cannot send real SMS or grant a router session. No production receiving number or merchant credentials are configured by this feature.

## Official EcoCash contract reviewed

The [Online Payments documentation](https://developers.ecocash.co.zw/docs/online-payments) describes merchant collections using HTTP Basic authentication and these sandbox endpoints:

| Operation | Endpoint |
| --- | --- |
| Initiation | `POST https://developers.ecocash.co.zw/sandbox/payment/v1/transactions/amount/` |
| Lookup | `GET https://developers.ecocash.co.zw/sandbox/payment/v1/{endUserId}/transactions/amount/{clientCorrelator}` |

Online Payments is distinct from the EPG `serviceRequest` family. Its request carries merchant configuration, a customer number, monetary terms and merchant-generated correlation references. The documented successful lookup echoes those references and the customer, with `ecocashReference`, `transactionOperationStatus:Charged` and `responseCode:00`. Its example does not return paid amount, currency or merchant identity. `notifyUrl` is optional.

The [general Errors page](https://developers.ecocash.co.zw/docs/errors) lists EPG errors. Those codes do not establish an Online Payments terminal-failure or reversal mapping. A not-found response is not treated as permission to charge again.

The [Go Live page](https://developers.ecocash.co.zw/docs/go-live) requires merchant registration and review of testing before production credentials/endpoints are issued. None have been requested or supplied for this work.

## Implemented boundary

`src/ecocash.ts` is a standalone sandbox preparation adapter. It has no import from the application checkout registration and does not implement the settlement `PaymentAdapter` interface. Its only network destinations are the fixed official sandbox paths above. Configuration is explicit constructor input; no environment variable activates it.

`prepareEcoCashPayment` creates immutable request context from server order terms and a unique attempt UUID. The same UUID becomes the correlation and reference values. The caller must persist the complete context before any initiation; automatic retry of the POST is prohibited. A timeout preserves the original lookup identity. The implementation itself performs no automatic POST retry and exposes a separate read-only lookup method.

Initiation always returns `lookup_required`, including transport errors and reported success. Lookup verifies the echoed correlation, reference and customer, checks the provider reference shape and requires the documented status/code combination. A matching result returns `review_required` with `settlement_terms_unverified`. It never infers monetary proof from the request or accepts unqualified extra response fields as a new settlement contract. It cannot create an entitlement or mark a charge verified.

Responses are bounded to 64 KiB; requests have finite timeouts and disallow redirects. Callback URLs are omitted because the reviewed public pages do not specify an authenticated callback and replay-protection contract. Customer PINs are never requested. The merchant sandbox PIN belongs only in private adapter configuration. Credentials use JavaScript private fields and are not returned with observations.

The standalone adapter can also prepare a sandbox-only `REF` or `REV` request against the documented refund endpoint, using a fresh adjustment identifier and an original EcoCash reference. The request amount is capped at the original request amount. A documented, matching `Refunded` response still returns `review_required`; a reversal response or ambiguous result stays `unknown`. The module does not track cumulative refunds, retry a POST, change the ledger, or enable a provider. The future caller must persist adjustment context, prove the original settlement and enforce cumulative refund limits before any provider call. These sandbox helpers are not a production refund system.

Contract tests use fake HTTP responses only. They cover the documented request/authentication, loss of the initiation response, repeated lookup without another POST, reference/customer mismatch, status/code mismatch, oversized/malformed/error replies, rejection of production configuration and the absence of automatic fulfillment.

## Inputs needed before a real integration can be enabled

1. Approved merchant credentials and terminal/merchant configuration, verified customer test numbers, and the provider-issued production endpoint contract.
2. An authoritative settlement response or merchant reconciliation contract that independently proves the paid amount, currency and destination merchant, tied to the immutable correlation identity. Request values alone do not supply that evidence.
3. Documented terminal-failure, pending, reversal/refund and duplicate-request behavior, including accepted correlation length/format. The prepared UUID format requires provider acceptance testing.
4. Controlled sandbox evidence for success, declined/insufficient funds, timeout, ambiguous response, duplicate request, missing lookup and reversal scenarios. If callbacks are introduced, their authentication, canonicalization and replay rules must also be qualified.

After those inputs are available, implementation still needs a qualified direct-provider ledger identity, encrypted durable customer/correlation context before the first POST, a provider-specific reconciliation worker and customer approval UI. Those are deliberately absent from the current runtime so a configuration change cannot start unsupported charges.

## Historical provider compatibility

Migration `026_provider_identity.sql` retains `pesepay` for historical rows and adds a truthful `mock` identity. It relabels an older simulator record only when its provider reference and order both match a local mock record. All other historical records remain unchanged. The current worker filters its claims by provider, and reconciliation verifies adapter identity before an external check and again under the transaction lock.

Historical status remains readable by its owner even with checkout disabled. It describes the existing ledger, without contacting Pesepay or silently completing unresolved old transactions. The removed provider has no callback, sandbox registration, configuration selector or active reconciliation worker in the application.
