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
| Visa/Mastercard through a bank | Stanbic and CBZ advertise online card acceptance; ZB publishes a bank-operated payment gateway. CABS is an additional bank candidate, with online merchant enablement still to confirm. | Select the acquiring bank before implementing its exact protocol. Prefer a bank-approved hosted payment page or secure hosted fields. | Existing/preferred business bank, approved merchant account, settlement currency/account, test credentials and gateway contract |
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

### Bank comparison and selection checkpoint

The research recommendation is to request a specific online-card offer from **Stanbic**, obtain a competing **CBZ** offer, and include **CABS** for the local-card/Zimswitch requirement. **ZB Smile&Pay** is a further candidate when combining cards and wallets under one bank arrangement is valuable. This is a provisional assessment of published evidence, not a bank selected, an account opened, or a finding that one bank is cheapest or more reliable.

| Candidate | Verified public capability | Qualification still needed |
| --- | --- | --- |
| Stanbic | Online Visa/Mastercard acceptance; a linked merchant contract includes hosted checkout, payment links and API options. Its general settlement terms describe next-business-day crediting of valid processed transactions, subject to the agreement. | Current online quote, actual gateway provisioned, approved USD merchant/account, foreign-issued card coverage and approval for prepaid internet access. |
| CBZ | Visa/Mastercard/Zimswitch e-commerce offering. The processor's own directory explicitly identifies CBZ's iVeri gateway; iVeri Lite provides hosted checkout, optional 3-D Secure, lookup and reporting. | Current commercial terms, USD profile, enabled authenticated verification and refund functions, settlement timetable and sandbox access. |
| CABS | Its official merchant page confirms POS acquiring and Zimswitch-enabled CABS cards. | CABS must confirm that it will onboard PamoFi for **Zimswitch Online merchant acquiring**, and separately whether online local/foreign Visa/Mastercard acquiring is offered. Card issuing and physical POS support do not establish those approvals. |
| ZB / Smile&Pay | ZB states that it owns Smile&Pay and advertises Visa/Mastercard, Zimswitch, EcoCash, InnBucks and other wallets. Its related SmileLink product explicitly supports international Visa/Mastercard. | Exact API product, merchant/settlement terms, authenticated payment verification, refunds and sandbox acceptance. SmileLink's account requirements do not automatically establish the separate API contract. |

Primary sources: [Stanbic merchant contract](https://www.stanbicbank.co.zw/static_file/zimbabwe/e-Forms/Business/Ecommerce%20Application%20Contract.pdf), [CBZ e-commerce](https://www.cbz.co.zw/ebanking-services/e-commerce/), [iVeri bank directory](https://www.iveri.com/knowsystem/contact-information-1414), [iVeri hosted checkout](https://www.iveri.com/ecommerce), [CABS merchant/POS services](https://www.cabs.co.zw/personal-banking/channels/pos), [ZB gateway ownership and channels](https://www.zb.co.zw/holding/media/insights/reimagining-future-payments), and [SmileLink](https://www.zb.co.zw/banking/smilelink).

### CABS and Zimswitch have different roles

An acquiring bank holds the merchant relationship and agrees the settlement arrangement. Zimswitch supplies payment-network and online-gateway facilities. Its [official merchant guidance](https://zimswitch.co.zw/zimswitch-online/) directs merchants to their bank for sign-on, then to its linked gateway integration guide. A CABS merchant arrangement and Zimswitch Online could therefore be used together **if CABS confirms the required online acquiring product**.

The public evidence checked here does not establish CABS's current online merchant onboarding, sandbox, settlement timetable or all enabled brands/currencies. An online cardholder's ability to pay with a CABS-issued card is a different capability from PamoFi accepting cards through CABS. A network participation logo is also insufficient evidence of PamoFi merchant approval. The separate `zimswitchonline.co.zw` directory was not used to establish acquiring eligibility because its provenance from the official main-domain guidance was not verified during this review.

Zimswitch's [official C-Trade announcement](https://zimswitch.co.zw/press-release/zimswitch-welcomes-c-trade-to-the-zimswitch-online-ecommerce-platform/), effective 30 November 2023, explicitly includes CABS among banks whose local cards could fund a C-Trade wallet through Zimswitch Online. This is historical evidence of **CABS-issued card acceptance on that merchant's checkout**. It does not establish CABS's own online merchant-acquiring offer, current USD availability, or terms for PamoFi.

Keep domestic Zimswitch acceptance and international Visa/Mastercard acceptance as separately qualified methods. Neither a bank name nor a payment-network name is a runtime provider identifier until a concrete merchant/gateway contract is implemented and tested. No `cabs`, `zimswitch`, `stanbic`, `cbz` or `zb` checkout mode is enabled by this investigation.

### Pricing: merchant charges and bank-account charges are separate

Stanbic's older [Card & Payments booklet](https://www.stanbicbank.co.zw/static_file/zimbabwe/Common%20Content/Downloadable%20files/Card%20%26%20Payments%20Booklet.pdf) advertises N-Genius e-commerce at 3.7%, a USD10 monthly commission minimum and no setup cost. Its undated, currently linked [e-commerce application](https://www.stanbicbank.co.zw/static_file/zimbabwe/e-Forms/Business/Ecommerce%20Application%20Contract.pdf) instead prints 2.5% excluding VAT, nil activation, a USD10 minimum when monthly commission is lower, and USD25 excluding VAT per chargeback. That form mixes POS and e-commerce terminology. **Neither rate is a confirmed current PamoFi online offer.** Confirm the monthly-floor calculation rather than automatically adding USD10 to the percentage charge.

No complete current online merchant quote was established for CBZ, CABS or ZB. The following amounts are separate published **account charges**, not card-acquiring commissions or complete checkout prices:

| Bank / account category | Published USD service charge | Document and limitation |
| --- | --- | --- |
| Stanbic Enterprise / Corporate | USD20 / USD40 | [June 2026 schedule](https://www.stanbicbank.co.zw/static_file/zimbabwe/About%20Us/Personal/June_ZWG_and_USD_2026_.pdf), service-fee section. Confirm the assigned account category and additional online-banking subscriptions. |
| CBZ business account | USD26 per month | [Linked business conditions](https://www.cbz.co.zw/?ddownload=8994) are headed August 2026 although the website link was labelled October. |
| CABS Nostro FCA Domestic / Non-Resident FCA | USD20 per month for each listed category | [June 2026 business conditions](https://www.cabs.co.zw/sites/default/files/CABS%20BUSINESS%20CONDITIONS%20JUNE%202026.pdf). Confirm which category and any waiver apply to the approved merchant account. |
| ZB corporate account | USD30 per month | [October 2026 business conditions](https://www.zb.co.zw/banking/business-conditions). Confirm any merchant/SME account alternative. |

CABS's `Online USD` tariff rows describe purchases using CABS cards. Its small-transaction exemption wording does **not** establish free merchant acquiring for PamoFi. Issuer/cardholder charges, ATM/POS charges and gateway commissions must not be substituted for a written e-commerce merchant offer. No public tariff has been hard-coded into application prices or provider limits.

PamoFi's USD0.50–5 purchase sizes make fixed fees important. A USD10 monthly merchant minimum alone consumes 10% of USD100 monthly card sales, before account costs. Compare minimum payment, percentage and fixed per-payment fees, monthly gateway/merchant/account fees, applicable taxes, refund fees, retained original commission, chargebacks, reserves and transfer/withdrawal costs using the same expected volume. Request launch-period waivers rather than assume them.

### Merchant identity and protocol qualification

The bank must approve prepaid internet access and identify the entity that signs the merchant agreement, holds the settlement account, invoices customers and owns the checkout. Whether Onesa UG can contract directly or needs an approved Zimbabwe operating entity/branch remains unresolved. A non-resident account option or diaspora product does not establish corporate merchant eligibility. [Stanbic's business application](https://digital.stanbicbank.co.zw/open-an-account/business-account) includes a country-of-incorporation field for non-residents; it does not itself approve this arrangement.

The preferred card design is a server-created checkout with a bank-approved hosted payment page or hosted fields, followed by server-side status verification. Direct contracting with a bank does not require PamoFi to collect card numbers or CVVs. A bank's appointed processor can still handle the card entry and issuer authentication.

Zimswitch's [officially linked integration guide](https://zimswitch.docs.oppwa.com/integrations/widget) describes server-created checkout, a hosted form and a subsequent status query. It specifically requires comparing returned identifiers, amount, currency, brand and payment type. Those concepts fit PamoFi's immutable orders and exactly-once fulfillment; the bank's exact enabled products and API endpoints still govern the implementation. N-Genius also distinguishes a [direct card-data API](https://docs.ngenius-payments.com/v2.0/reference/direct-api) from hosted entry and identifies the additional card-data security obligations of the former. Hosted entry does not by itself certify the whole application.

Stanbic's older booklet names N-Genius; current provisioning still requires confirmation. If supplied, its [order-status API](https://docs.ngenius-payments.com/reference/retrieve-order-status-pbl) returns payment state and amount/currency/outlet data for server verification. Its current [webhook guide](https://docs.ngenius-payments.com/reference/consuming-web-hooks) says events are unsigned, permit a configured secret header, and are sent once without retries. A webhook is a trigger for authenticated lookup, with durable background reconciliation for missed delivery. A return URL, notification or authorization alone cannot fulfill a sale requiring capture. Bank payout settlement and verified successful sale/capture are separate stages.

For CBZ/iVeri, obtain the bank-enabled lookup/refund contract and test profile, not just a generic gateway example. For ZB, obtain the full status-response identity/amount/currency binding and reversal/refund contract. Test payment and issuer authentication through the actual hotspot before access is purchased, as well as desktop and native/system-browser return behavior. Do not broadly open the hotspot's pre-login network to make a payment test pass.

## Acceptance before digital activation

For the selected provider, the integration record must contain:

1. The approved merchant and environment, exact endpoint/origin allowlists, protected credentials, immutable order terms and provider correlation scheme.
2. Sanitized real sandbox evidence for success, denial, cancellation/expiry, lost initiation response, duplicate delivery, late success, reversal/refund and mismatched identity/amount/currency.
3. A qualified server-side verification rule. Browser redirects, screenshots, customer SMS messages and agent assertions are not digital settlement evidence.
4. Exactly-once crediting and durable unresolved states. An ambiguous charge stays visible for review and cannot be replaced by another charge merely because the page refreshed.
5. Actual native/system/captive-browser return behavior and narrowly approved pre-login access to required provider and issuer pages.
6. Settlement reconciliation, refund ownership, observable failed queues and a tested operator review process.

The immediate external choices are the owner's **preferred/existing business bank** and the **direct EcoCash and InnBucks merchant access packs**. Use proper business identities for merchant contracts; temporary application test emails are not a substitute for merchant enrollment.
