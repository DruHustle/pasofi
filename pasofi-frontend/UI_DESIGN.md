# PasoFi mobile-first customer experience

The customer interface uses PasoFi's identity across the independent web and native mobile projects. The first layout is a phone screen; wider screens expand the same navigation and content rather than introducing a separate customer journey.

## Design system

| Role | Color | Usage |
| --- | --- | --- |
| Forest | `#102B29` | Brand, primary text on mint, dark account surfaces |
| Mint | `#00B894` | Primary actions, data indicators and restrained accents |
| Canvas | `#F5F8F7` | App background |
| Ink | `#172B4D` | Supporting interface text |
| Amber | `#FFB547` | Waiting and attention accents |

Use dark forest text on mint. White text directly on `#00B894` does not have sufficient contrast for ordinary text. System fonts avoid an external font request in captive browsers. Inline SVG icons supplement visible text; they are decorative when the control already has an accessible name.

Primary controls and navigation have generous touch targets. Mobile navigation includes bottom safe-area spacing; the page reserves room for it. Form text remains readable at narrow widths, and reduced-motion preferences disable nonessential motion.

## Customer destinations

| Destination | Purpose |
| --- | --- |
| Home | Recorded account dashboard for returning customers; welcome, immediate buy/redeem/connect actions and published offers for guests |
| Bundles | Published data, validity, exact currency and price, with filters derived from returned products |
| History | Owned allowance records and their activation, usage, expiry or reversal state |
| Account | Recovery, another-device handoff and explicit sign-out controls |
| My WiFi | Authoritative connection status and registered hotspot sign-in controls |
| Vouchers | Explicit voucher redemption and private agent receipt pairing |
| Help | Searchable reviewed answers, without sending the typed question to a model or external support service |
| Staff | Existing separately authenticated agent, support and administrator workspaces |

The web shell uses `#home`, `#bundles`, `#history`, `#account`, `#wifi`, `#voucher` and `#help` destinations. `/connect` and `/#connect` are lightweight captive entry points with bundle and voucher actions. They do not install a RouterOS login page or change router configuration.

Bundle filters follow published validity: Daily is at most one day, Short stays is over one and at most three days, Weekly is over three and at most seven days, Longer is over seven and at most 27 days, and Monthly is over 27 days. Empty categories are omitted. Each card retains its exact validity; a category is only a way to browse. The current product contract has finite byte allowances, so the interface does not invent an Unlimited category.

## Account, payment and connection truth

Browsing products or opening an existing account never silently creates a new customer identity. The existing guest session is created after an explicit purchase, pairing or redeem action, without requiring registration before the first purchase. Customers who need their previous account can recover it before starting another.

The redesign keeps the existing owner checks, request generations, cookie verification and idempotency handling. An unfinished checkout retains its original details and retry key. A missing response is not treated as a failed payment that can simply be charged again.

These states remain different:

- A cash receipt is the authorized agent's attestation that the exact cash amount was received.
- A payment is confirmed only by authoritative fulfillment evidence.
- Redeemed allowance is queued until successful hotspot activation.
- Preparing short-lived hotspot credentials does not mean the device is connected.
- A connected indicator requires a fresh, owned usage snapshot with the server's active and connected state.
- Offline or delayed checks keep the last confirmed balance with a visible freshness label and withdraw connection certainty.

Remaining data comes from the whole-account ledger snapshot, independently of paged history. Queued data is included in the total and also identified separately. Outstanding reservations are not subtracted twice. Bundle time comes from the selected entitlement's expiry; the shorter session grant deadline is not used as bundle expiry.

Payment methods continue to depend on backend capabilities and enabled provider methods. A new appearance does not enable EcoCash, InnBucks, card acquiring, Apple Pay or Google Pay. Approved-provider integration and actual payment qualification remain independent from the interface release.

## Native independence

The Capacitor app remains an independent build with its own source and dependencies. It imports no web or backend package. Deliberately maintained account components can share the same visual behavior through corresponding source changes while keeping the build boundary intact.

Without a configured qualified HTTPS gateway, the native app is clearly marked as an offline preview. Example bundles are labeled as examples and cannot be purchased. Even with a gateway configured, live native account features require the server's `mobileCookies` capability. A successful web test does not establish iOS or Android cookie, signing, physical device or captive-browser acceptance.

## Validation

The fixture-driven `web/tests/premium.spec.ts` suite checks the customer experience at 320, 390, 430 and 1280 pixels. It verifies navigation, touch targets, horizontal overflow, valid bundle filters, explicit guest session creation, cash receipt pairing, queued voucher allowance, independent bundle/session time and offline status. It also checks that the keyboard skip link preserves checkout and that another tab's sign-out clears private History into a usable Home screen without silently restoring an account. It captures app screenshots for visual review. The layout assertions are automated; the captures are not platform-specific pixel goldens.

Run the application server in one terminal:

```sh
cd pasofi-frontend/web
npm run dev -- --host 127.0.0.1 --port 5187 --strictPort
```

Run the isolated frontend checks against that loopback server:

```sh
cd pasofi-frontend/web
npm test
npm run build
PAMOFI_BASE_URL=http://127.0.0.1:5187 npm run test:browser -- tests/premium.spec.ts tests/resilience.spec.ts tests/workspaces.spec.ts tests/usage.spec.ts
```

If the environment uses an existing Chromium executable, set `PAMOFI_CHROME_PATH` to its absolute path. Playwright stores screenshots and failure context in the ignored `test-results` directory. These isolated tests intercept API responses and do not contact real payment providers, create public customer accounts or operate a router.

The real-service commerce suite and native build workflows remain separate verification gates. No fixture result alone establishes a production payment or a physical hotspot connection.

The verification workflow retains isolated UI screenshots and test context for three days in its private `pamofi-ui-evidence` artifact. These are review materials generated from synthetic test accounts, not screenshots of production customer data.
