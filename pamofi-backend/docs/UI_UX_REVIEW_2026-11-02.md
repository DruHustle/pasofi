# PamoFi experience and workflow review — 2 November 2026

## Scope and baseline

Review requested before implementation: benchmark the deployed PamoFi web app against Vodacom, Cell C and strong self-service experiences, test customer and staff journeys, fix confirmed gaps, and improve the vibrant visual identity.

Source reviewed: `DruHustle/pamofi` main `9303afc2e62f25c9e9f1d4404ed8618ed64f099c`. Existing production release evidence records source `624ab511c1cdc8ee0750d9456d3faa5700042127` on Vercel. Live browser inspection confirms the website is reachable and reports **Service in preparation**. Bundles navigation reaches `#bundles`; no bundles are published. Live payments, SMS and physical hotspot acceptance remain unqualified. No test result below should be read as proof of those integrations.

## Review checklist (created before code changes)

| ID | Area | Acceptance criteria | Review method |
| --- | --- | --- | --- |
| N1 | Navigation | Main, quick-action and footer routes work; direct entry, reload, Back/Forward and close preserve the intended screen. | Live browser + regression tests |
| N2 | Rendering failures | A missing lazy workspace chunk has an understandable retry/reload route; navigation shell stays usable. | Source + controlled failure test |
| B1 | Catalogue | Loading, empty, failed and populated states are distinct; refresh can pick up new availability. | Live empty state + isolated fixtures |
| B2 | Comparison | Data, validity, currency and price are legible and consistent; useful filters/sorting and result count; no invented popularity or recommendation. | Source + isolated populated catalogue |
| B3 | Purchase | Selected bundle, quoted terms and total stay consistent; double submits and retries cannot duplicate a transaction. | Isolated backend/browser integration |
| B4 | Payment readiness | Pending providers do not accept payment or show false success; agent-confirmed cash remains a separate workflow. | Live capabilities + integration tests |
| C1 | Customer identity | Test the actual passwordless customer account lifecycle, recovery reference/key, device handoff, session expiry and sign-out. Staff registration/password/MFA are separate. | Source + isolated tests |
| C2 | Vouchers/receipts | Valid, invalid, expired, consumed and retry paths are actionable; input errors do not freeze a sale. | UI + service tests |
| C3 | Usage | Remaining data/time, expiry, stale data and network state have correct units and honest status. | Isolated state fixtures + integration tests |
| H1 | Hotspot | Connection help explains the required WiFi network; voucher acceptance is distinct from confirmed access. | Source + live unavailable state; physical test deferred |
| S1 | Staff setup | Authorized administrators can prepare users, sites and catalogue while customer commerce is disabled. Sales remain gated. | Source + isolated authorization tests |
| S2 | Agent sales | Assigned-site stock, receipt pairing, validation, retries and failed confirmations recover correctly. | Source + integration tests |
| S3 | Administration | Role restrictions, catalogue publishing/allocation, audit and network review paths work without partial-load dead ends. | Source + integration tests |
| U1 | Visual design | Strong green-led colour identity, readable hierarchy, consistent cards, usable primary/secondary actions and original imagery. | Desktop/mobile visual review |
| U2 | Accessibility | Keyboard focus, labels, status announcements, readable contrast, comfortable tap targets, reduced motion and no horizontal overflow. | Source + browser checks |
| U3 | Help/trust | Searchable useful answers, real availability, clear service terms and appropriate privacy information; no fabricated support contacts or locations. | Live browser + source |
| R1 | Reliability | Slow/failed requests, offline use, stale sessions and interrupted submissions offer a truthful next action. | Controlled regression tests |
| R2 | Release | Build and meaningful tests pass; report exact tested scope, remaining operational blockers, source revision and deployment status. | Build/CI evidence |

## Benchmark observations

- [Vodacom](https://www.vodacom.co.za/): live rendered homepage uses a high-contrast promotional hero, prominent search/account actions and strong product imagery. Adapt the clear hierarchy and purchase visibility to PamoFi's smaller offering.
- [Cell C](https://www.cellc.co.za/cellc/home): live rendered page combines a bold brand accent and lifestyle photography with direct data/recharge and help routes. Its [bundle workflow](https://www.cellc.co.za/cellc/get-databundles) exposes bundle choice and purchase summary.
- [giffgaff plans](https://www.giffgaff.com/sim-only-deals) and [app](https://www.giffgaff.com/mobile-app): comparable plan information, price/data sorting, balance, top-up and voucher actions are relevant self-service patterns.
- [rain home WiFi](https://www.rain.co.za/5Ghomewifi): repeat the same attributes across a small plan range and state service qualifications visibly.

These are design references, not claims that every competitor journey passed testing. Do not copy their trademarks, customer claims, tariffs or artwork.

## Initial findings before implementation

1. **Operational blocker:** the live catalogue is empty and purchases/connections are unavailable. A frontend redesign cannot qualify providers or physical hotspot access. The preparation state must stay truthful.
2. **Administrator setup defect:** setup data reads are coupled to the commerce-enabled switch; a disabled service can obstruct preparation despite valid administrator authorization.
3. **Agent retry defect:** definitive input rejection can leave an immutable pending sale in place and prevent correction.
4. **Routing gap:** purchase and private-receipt tools share the catalogue hash, so direct reload/back loses the selected workspace.
5. **Rendering resilience gap:** lazy workspaces have no error boundary for failed module loading.
6. **Catalogue usability gap:** no sorting/result count; a hardcoded product receives an unsupported recommendation label.
7. **Visual gap:** small supporting text and muted colour reduce legibility and energy. Retain the existing green identity and photograph; use stronger accents and more readable information.

## Verification and resolution

### Confirmed defects addressed

| Finding | Resolution | Checklist |
| --- | --- | --- |
| Reload or Back lost the purchase/receipt workspace and selected bundle. | Distinct checkout, receipt, staff and handoff routes; public bundle IDs survive reload; selection changes update the route. Prices and private credentials are never placed in the URL. An unpublished selection requires a deliberate replacement. | N1, B3 |
| Failed lazy imports could remove the working application. | A screen error boundary retains the navigation shell and provides reload/catalogue recovery. Returning to the catalogue also resets a failure on that same route. | N2, R1 |
| Plans were harder to compare than the reference experiences. | Visible result count, price/data/validity sorting, stable duration filters, readable plan attributes and currency grouping. Removed an unsupported product recommendation. | B1, B2 |
| Muted colour and very small supporting copy weakened the visual hierarchy. | Retained PamoFi's forest-green identity and existing imagery; introduced emerald, lime, amber and lavender accents, stronger headings and readable supporting text. Selected text/accent pairs exceed 4.5:1 contrast. Desktop and 320/390/430px layouts are exercised by browser tests. | U1, U2 |
| Administrator preparation depended on commerce already being enabled. | MFA-authorized administrators can read setup data, create sites and create/publish bundle versions while selling is paused. Agent sales, inventory allocation and customer commerce retain their enablement gates. | S1 |
| A failed setup request hid otherwise usable administration sections. | Independent resource loading with section-specific failure/retry; approval of site-based roles is blocked while their site list is unavailable. | S3, R1 |
| Invalid agent input could become an immutable, uncorrectable saved sale. | Validate new pairing codes and phone numbers before saving a request; normalize supported spacing and Zimbabwe phone formats. Clear legacy malformed requests only after authoritative rejection. Preserve ambiguous outcomes and their original retry keys. | C2, S2 |
| An allocation replay could fail after the agent's role/site changed. | Recover an already-committed allocation under the same-key database lock before consulting mutable eligibility. Definitive non-commit rejections let the form be corrected. Identity outages, authentication failures and malformed identity responses remain unavailable/uncertain, preserving the original request. | S3, R1 |
| Withdrawn bundles or paused checkout could make a saved purchase impossible to check. | Owner-scoped, read-only exact request-key order lookup, with an echoed lookup key to reject legacy list responses. Status controls remain accessible with checkout paused. Restoration never creates an order or retries a provider payment. | B3, B4, R1 |
| Delayed order lookup/quote-close responses could interfere with a newer purchase. | Require current session, owner, lookup sequence and unchanged saved intent before applying lookup results; require a current component/session before quote-close storage cleanup. Controlled out-of-order regressions verify the newer purchase survives. | B3, R1 |
| Customers could overlook recovery details after acquiring data. | Show a recovery-details reminder after voucher redemption or verified fulfilment. Remove unqualified Apple Pay/Google Pay presentation from pending payment options. | C1, B4, U3 |

### Live production checks

At `2026-11-02T21:47:48Z`, anonymous read-only requests confirmed:

- `/` and `/connect` return HTTP 200 HTML.
- `/api/capabilities`, `/api/bundles`, `/api/sites` and `/api/help` return HTTP 200 JSON with `Cache-Control: no-store`.
- Capabilities report `demo: false`, `paymentMode: disabled` and all customer commerce/network flags disabled. The published bundle list and public site list are empty.
- Customer session/access/usage and staff session endpoints reject anonymous requests with HTTP 401.
- The paused-production admin catalogue and nonpublic readiness route return HTTP 404.
- Live browser navigation, the empty catalogue, recovery entry points and help search were inspected. No real account, sale, payment, SMS or router operation was created during this review.

These findings verify the public preparation state. They do not establish working live purchases or hotspot connectivity.

### Test evidence

Focused checks passed before publishing the candidate: 14 navigation/recovery browser regressions, 18 catalogue/premium/customer browser checks, and 9 real-database commerce regressions. Independent source review found and resolved the delayed-response defects above.

The full strict application/browser gate and repository CI results are recorded below when completed. A failed, skipped or interrupted run is not counted as acceptance.

### Remaining launch requirements

1. **Catalogue and locations:** approve real bundle prices, allowances and validity; configure real sales sites; publish the approved versions. Test fixtures are not commercial offers and must not be copied into production as such.
2. **Staff operations:** prepare authorized MFA-enrolled administrators and assigned-site agents, enable the approved sales path and allocate real stock. Staff password reset/lost-authenticator recovery still needs a defined, audited process; this change does not introduce an MFA bypass.
3. **Payments and delivery:** qualify each chosen provider with its real credentials, callback verification and reconciliation, then enable it. EcoCash, InnBucks, bank/card and SMS remain unqualified. This review does not add or activate Pesepay.
4. **Physical connectivity:** complete router/site provisioning and supervised real-device hotspot acceptance, including disconnect, expiry, usage accounting and reconnection. Successful isolated network tests are not physical-site acceptance.
5. **Customer trust:** supply approved privacy/terms and a real support/escalation route. The existing bundle terms and searchable help are useful, but they are not a complete commercial policy set.
6. **Release:** promote the reviewed backend and frontend together, preserve existing disabled integration flags, verify the deployed revision and repeat live smoke checks. No source-code test result alone proves deployment.

The exact PostgreSQL 17.11, Docker/FreeRADIUS/TLS/backup/staging/firewall labs and Android/iOS native compile gates require CI or their specified host environments. Local verification uses an isolated PostgreSQL 16 cluster and real Chromium, with synthetic data only.
