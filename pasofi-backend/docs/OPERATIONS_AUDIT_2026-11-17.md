# PasoFi operations audit — 17 November 2026

**Scope:** Repository inventory plus targeted source/contract review on 2026-11-17. The `main` tree contains 935 entries, including 793 tracked files, 150 test/spec files and 7 checked-in RouterOS `.rsc` scripts. File presence does not prove test success, working hardware or deployment. This record does **not** claim that all 793 files have been manually reviewed or that new changes are running in production.

| Area | Tracked files | Evidence / remaining work |
| --- | ---: | --- |
| Backend services: identity, prepaid, network, notifications, assistant | 244 | Existing integration runner and isolated PostgreSQL tests. Need exact deployed image/DB migrations, real payment/SMS authority, support workflow and recovery verification |
| RouterOS and captive portal | 43 | Seven checked-in `.rsc` scripts statically screened for obvious assignment-style embedded credentials; no matching `password=`, `secret=` or `private-key=` assignments in those scripts. That narrow check is not a secret audit of every file. Site-01 has inspected legacy hAP lite and prepared pilot; site-02 hardware/HotSpot unverified |
| Infrastructure and FreeRADIUS | 153 | Private tunnels, mTLS, client registration, control/absence and server restore labs exist. Verify actual Oracle host, UDP source address, NAS and per-device trust, expiry, live accounting and disconnect |
| Web frontend | 99 | Vercel/Oracle proxy and browser suites exist; exact current production revision, payment options and customer flow require live checks |
| Native clients | 154 | iOS/Android preview pipelines exist. Debug APK/unsigned simulator are not signed release/store apps. Run installed device and real callback qualification |
| CI and local deployment | 62 | Latest PR jobs may remain queued; verify all required checks on the exact head before merge. Deployment must preserve database, volume, image, protected routes and rollback |
 
## Confirmed issues under repair

1. **Lawfield RouterOS bootstrap:** Earlier stage-one preparation unconditionally required a separate HotSpot package and queried a HotSpot menu; both are unrelated to creation of a disabled WireGuard interface and may fail on valid RouterOS architectures or absent packages. [PR #139](https://github.com/DruHustle/pasofi/pull/139) moves these checks to the later device-specific acceptance gate and adds regression tests.
2. **Lawfield captive credentials:** The offline Lawfield draft had a credential form targeting the original site-01 HotSpot HTTPS hostname. [PR #139](https://github.com/DruHustle/pasofi/pull/139) removes the form. A real login must be generated only after Lawfield's own hostname, certificate and router are inspected.
3. **Two EcoCash journeys:** [PR #138](https://github.com/DruHustle/pasofi/pull/138) presents both in-app Online Payments and independently initiated Pay Merchant. The documented sandbox Online Payments response does not independently prove actual amount/currency/merchant; customer-initiated incoming-merchant API/webhook contract is not yet provided. Real-money EcoCash activation remains closed.
4. **Identity registration lanes:** [PR #137](https://github.com/DruHustle/pasofi/pull/137) separately addresses customer and staff registration routes. Check current Identity issuer, site/role/MFA grants and native callback on deployed clients before promotion.

## Critical launch blockers — exact owner and acceptance

| Priority | Owner / dependency | Required proof |
| --- | --- | --- |
| P0 — Hardware & operations | PasoFi operator and networking engineer | Current K1/G1/G2/G3 and Lawfield serial/model/RouterOS inventory, verified L2/L3 uplink topology, protected management path, dedicated guest bridge, independent off-site authenticated login, reboot/rollback and capacity. Do not apply site-01 scripts to other devices |
| P0 — Customer Wi-Fi | Networking/backend engineer plus physical operator | One paying-customer session with phone mobile data OFF: authentic HTTPS HotSpot login, correct RADIUS Access-Request/Accept, accounting Start + one-minute Interim, upload/download byte enforcement, exact Stop, confirmed absence and cross-site reconnect |
| P0 — Cash launch | Approved operator, backend engineer | Current staff MFA/role and site, exact cash amount, assigned stock, shift, one paid receipt/invoice and voucher, one redemption, actual network service. No synthetic sale used as proof |
| P0 — Payment safety | Backend / EcoCash / Stripe | Provider-qualified exact settlement, amount, merchant, currency and reversals; idempotent fulfillment and network admission. Continue accepting money only on explicitly qualified routes |
| P0 — CI | Release engineering | Required workflow check results on exact head commit and tested merge; never merge due to queued/green-on-different-SHA checks |
| P1 — Native release | Mobile release engineering | Signed iOS archive and Android AAB, account recovery/deep links, privacy/support/store submission, physical device tests |
| P1 — Observability | Operations | Live backup restore, disk/memory alarms, tunnel/NAS/RADIUS health, payment review queues, SMS delivery unknown, expiring certs and operator recovery tests |

## No-go until independent evidence

The existing [cash HotSpot launch gate](CASH_HOTSPOT_LAUNCH.md) and [router acceptance record](../pasofi-routeros/commissioning/ACCEPTANCE.md) require actual hardware acceptance. A green local suite, deployed frontend, or simulation does not establish paid internet access. Preserve production payment, network and router-write gates until each receiving site and payment method individually qualifies.

### Source and operational references

- [PasoFi engineering rules](../../AGENTS.md)
- [Cash HotSpot launch](CASH_HOTSPOT_LAUNCH.md)
- [Router acceptance](../pasofi-routeros/commissioning/ACCEPTANCE.md)
- [Lawfield router stage one](../pasofi-routeros/site-02/README.md)
- [EcoCash merchant qualification](https://github.com/DruHustle/pasofi/blob/feature/ecocash-dual-customer-journeys/pasofi-backend/docs/ECOCASH_MERCHANT_LAUNCH.md)
- [GitHub release checks](https://github.com/DruHustle/pasofi/actions)
