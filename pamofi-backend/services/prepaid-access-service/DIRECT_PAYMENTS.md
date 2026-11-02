# Direct payment preparation

Reviewed on 2026-11-02. Cash sales remain the application purchase path. External digital checkout is unavailable; environment flags cannot activate Pesepay, EcoCash or a bank. Local demo simulation remains available independently.

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
