# Direct payment integration investigation — 2 November 2026

## Decision and current delivery

The owner has explicitly excluded Pesepay. PamoFi's intended digital connections are **direct EcoCash**, **direct InnBucks**, and **a bank's approved card-acquiring interface**. A bank may operate an appointed gateway; the commercial relationship and settlement account must belong to the selected bank arrangement. No replacement aggregator is selected by this document.

The immediate operating workflow is **cash paid to an authorized agent → recorded agent confirmation → private voucher receipt → customer redemption → queued allowance → verified router usage**. See [the cash workflow](AGENT_CASH_WORKFLOW.md). Digital payment preparation does not delay or impersonate that workflow.

This investigation used public provider and bank documentation. No merchant account, provider subscription, payment, refund, payout change or live credential was created or used. Application tests use unique synthetic temporary identities in isolated databases; they do not require real personal mailboxes.

## Direct connections and the remaining inputs

| Connection | Primary evidence | PamoFi implementation boundary | Input needed to proceed |
| --- | --- | --- | --- |
| EcoCash | Official Online Payments documentation publishes a dedicated collection and lookup API | A preparation/lookup adapter can be contract-tested against the published sandbox shape. Customer checkout and automatic fulfillment remain disabled until the settlement contract is qualified. | Approved merchant record, provider-issued sandbox access, authoritative status/settlement examples and later approved production access |
| InnBucks | The official merchant page advertises integration with its Merchant API | No production endpoint or wire protocol is inferred from third-party examples. No InnBucks charge path is enabled. | Official integration pack, environment URLs, merchant credentials, status/refund rules and acceptance requirements supplied by InnBucks |
| Visa/Mastercard through a bank | Stanbic and CBZ advertise online card acceptance; ZB publishes a bank-operated payment gateway | Select the acquiring bank before implementing its exact protocol. Prefer a bank-approved hosted payment page or secure hosted fields. | Existing/preferred business bank, approved merchant account, settlement currency/account, test credentials and gateway contract |
| Zimswitch cards through a bank | Zimswitch directs merchants to their bank and links its official integration guide | A separate bank-approved card method; participation does not establish that every card brand or currency is enabled for this merchant. | Bank merchant sign-on, approved brands/currencies, credentials and acceptance evidence |

Sources: [EcoCash Online Payments](https://developers.ecocash.co.zw/docs/online-payments), [InnBucks merchants](https://innbucks.co.zw/index.php/home/merchants), [Stanbic e-commerce](https://www.stanbicbank.co.zw/zimbabwe/personal/ways-to-bank/ecommerce), [CBZ e-commerce](https://www.cbz.co.zw/ebanking-services/e-commerce/), [ZB Smile&Pay](https://smileandpay.zb.co.zw/), and [Zimswitch Online](https://zimswitch.co.zw/zimswitch-online/). An advertised facility is evidence of a possible route, not PamoFi merchant approval.

## EcoCash implementation and evidence boundary

EcoCash's Online Payments API uses HTTP Basic authentication and separate endpoints from its EPG payout services. Its documented sandbox accepts a merchant-generated correlator and supports lookup without a callback. Customers authorize on EcoCash; PamoFi must never request their wallet PIN. A merchant security PIN is a different credential.

The published successful response includes transaction references and a status, but omits independently returned paid amount, currency and merchant identity. That leaves a material qualification gap for PamoFi's automatic crediting policy. A reported success must remain a review-only observation until an authoritative contract establishes how to verify those terms. Local expected values cannot be substituted as if the provider returned them.

The engineering boundary is therefore explicit:

- Keep the documented sandbox base fixed and reject redirects, malformed or oversized responses and mismatched references.
- Require a stable caller-supplied correlation identity before a future payment request. A lost response must lead to lookup of that identity, never an automatic second charge.
- Expose no public EcoCash checkout or callback route in this revision. A dormant adapter is not an operational payment integration.
- Do not interpret a timeout, undocumented failure or unknown reversal as a safe retry or permission to grant access.
- Preserve existing order and charge history. Mock tests must identify their own provider so they cannot consume historical jobs for a different provider.

These are PamoFi design decisions. Before enabling the adapter, run actual provider acceptance cases and obtain the missing response contract. EcoCash's [go-live process](https://developers.ecocash.co.zw/docs/go-live) requires merchant validation and test evidence; approved production credentials and endpoints are supplied after review. No configuration flag can replace that evidence.

The implemented dormant module and its exact remaining ledger/UI work are documented in [DIRECT_PAYMENTS.md](../services/prepaid-access-service/DIRECT_PAYMENTS.md). Its contract tests use fake HTTP replies; no real provider sandbox request was made. The application can construct only its demo mock payment adapter. Historical payment status remains readable by its owner while new external checkout is disabled.

## InnBucks implementation boundary

The official InnBucks merchant page establishes that a direct integration is offered. This review did not obtain an authoritative public API specification from InnBucks. Community examples were found, but they are not a sufficient contract for moving a customer's money or issuing prepaid access.

Request the official integration pack through the merchant relationship. It must resolve authentication/token rotation, code creation, amount units and currencies, expiry, exact paid/failed/reversed states, query limits, correlation after a lost response, duplicate handling, refunds and settlement reporting. Obtain the test customer mechanism and acceptance procedure as well. Only then should a provider-specific adapter and UI be implemented against sanitized real response fixtures.

## Card acquiring through a bank

**Stanbic** publicly offers online Visa and Mastercard acceptance. **CBZ** advertises Visa, Mastercard and Zimswitch e-commerce acceptance and lists business incorporation/director documents for applications. **ZB Smile&Pay** publishes merchant onboarding and bank-operated checkout/status APIs for cards and wallets. These are candidates for the owner's bank relationship, not a bank selected or opened by this work.

The preferred card design is a server-created checkout with a bank-approved hosted payment page or hosted fields, followed by server-side status verification. Direct contracting with a bank does not require PamoFi to collect card numbers or CVVs. A bank's appointed processor can still handle the card entry and issuer authentication.

Zimswitch's [officially linked integration guide](https://zimswitch.docs.oppwa.com/integrations/widget) describes server-created checkout, a hosted form and a subsequent status query. It specifically requires comparing returned identifiers, amount, currency, brand and payment type. Those concepts fit PamoFi's immutable orders and exactly-once fulfillment; the bank's exact enabled products and API endpoints still govern the implementation. N-Genius also distinguishes a [direct card-data API](https://docs.ngenius-payments.com/v2.0/reference/direct-api) from hosted entry and identifies the additional card-data security obligations of the former. Hosted entry does not by itself certify the whole application.

Before choosing a bank, obtain its current USD settlement terms, minimum transaction amount, fixed and percentage charges, refund/chargeback costs and settlement schedule. PamoFi sells small bundles, so fixed per-payment costs can materially affect the product. No historic brochure fee or unapproved currency has been hard-coded.

## Acceptance before digital activation

For the selected provider, the integration record must contain:

1. The approved merchant and environment, exact endpoint/origin allowlists, protected credentials, immutable order terms and provider correlation scheme.
2. Sanitized real sandbox evidence for success, denial, cancellation/expiry, lost initiation response, duplicate delivery, late success, reversal/refund and mismatched identity/amount/currency.
3. A qualified server-side verification rule. Browser redirects, screenshots, customer SMS messages and agent assertions are not digital settlement evidence.
4. Exactly-once crediting and durable unresolved states. An ambiguous charge stays visible for review and cannot be replaced by another charge merely because the page refreshed.
5. Actual native/system/captive-browser return behavior and narrowly approved pre-login access to required provider and issuer pages.
6. Settlement reconciliation, refund ownership, observable failed queues and a tested operator review process.

The immediate external choices are the owner's **preferred/existing business bank** and the **direct EcoCash and InnBucks merchant access packs**. Use proper business identities for merchant contracts; temporary application test emails are not a substitute for merchant enrollment.
