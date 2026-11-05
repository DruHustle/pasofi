# PasoFi mobile frontend

This is the independent React/Capacitor project for iPhone and Android. It has its own package lock, source and build; it imports no web/frontend sibling or backend source. Node.js 22 or newer is required.

With no API configuration, the app remains a useful **offline preview** of example bundles and reviewed introductory help. It makes no account, purchase or connection requests. Prices shown in that preview are illustrative, not live offers.

The optional customer client supports the same customer capabilities as the web app: published bundles, agent-first cash purchase guidance, vouchers, private agent receipts, live remaining/used data and queued allowance, capability-gated checkout/status, recovery, browser handoff and verified network status. Every operation remains disabled until a configured HTTPS gateway explicitly advertises a qualified mobile cookie boundary. The current backend deliberately returns `mobileCookies: false`; no mobile build setting can bypass that decision.

## Build and native projects

```sh
npm ci
npm test
npm run mobile:sync     # build and copy assets into both native projects
npm run mobile:ios      # open Xcode on macOS
npm run mobile:android  # open Android Studio
```

`npm test` checks TypeScript. After changing React or Capacitor configuration, run `npm run mobile:sync` before rebuilding native projects. Native web assets and generated Capacitor configuration are ignored by Git and regenerated. The app bundles its own frontend; never point a production WebView at a remote development server.

For iPhone, use Xcode with an installed iOS simulator runtime and select a simulator. A signed physical-device or App Store build requires the owner's Apple Developer team and signing configuration. The bundle ID `com.onesa.pasofi` is provisional until registered by the owner. The editable provisional icon is in `assets/app-icon.svg`.

For Android, use Android Studio, a compatible JDK 21 for Gradle and Android SDK Platform 36. The current Gradle 8.14 project does not support a JDK 25 runtime. A signed release requires an owner-controlled signing key, which must never be committed. Build and sync checks do not replace device/emulator testing.

## Configure the public HTTPS gateway

A qualified deployment can build its public gateway origin into the customer client:

```sh
VITE_PAMOFI_API_BASE_URL=https://api.example.invalid npm run mobile:sync
```

Only an HTTPS origin is accepted: no username, password, non-root path, query string or fragment. The setting is public build metadata, not a secret. Do not put service tokens, signing keys, router credentials or provider keys in any `VITE_` variable.

The selected browser deployment is Vercel with an authenticated Oracle gateway behind it. That Oracle endpoint accepts only the server-side Vercel proxy; it is not a direct native-app endpoint. Do not copy `PAMOFI_VERCEL_PROXY_TOKEN` into the mobile app or bypass the gateway to make a configured preview work. The current Vercel handler permits only its exact browser origin, and the backend still advertises `mobileCookies: false`. A native gateway/origin policy must be qualified with actual iOS/Android cookies before an operational mobile build is enabled; the preview builds remain API-unconfigured until then.

With a valid origin, the preview shows **My PasoFi**. That entry loads `/api/capabilities`. If the service is unavailable or `mobileCookies` is false, the client offers retry and the offline preview; it does not start account operations. A true capability permits only the individual features that the service also advertises.

The client sends explicit credentialed CORS requests to the configured origin, refuses API redirects, applies bounded timeouts, and verifies the current customer cookie after account creation, recovery and handoff. There is no bearer-token fallback in JavaScript storage. A service that accepts a mutation but fails to retain its cookie cannot be treated as an authenticated customer. This is covered in browser fault tests.

### Gateway/native qualification still required

Before a deployment may advertise `mobileCookies: true`, qualify its actual iOS and Android origins, cookie storage, SameSite/secure behavior, credentials/CORS policy and CSRF/origin checks together. Allow only the registered app/browser origins and credentials; do not replace origin checks with `*` or weaken them just to make a WebView request succeed. The current web-only backend origin/cookie policy has not been qualified for native app use. This repository's optional mobile client is prepared for that boundary, not evidence that it is already deployed.

Device acceptance must also cover app relaunch, interrupted requests, cookie blocking, logout/recovery, provider return navigation, clean browser handoff, captive Wi-Fi behavior, accessibility and short-lived hotspot sign-in. No live payment, SMS or Wi-Fi connection is claimed by the browser mocks.

## Customer privacy and state

Recovery keys, one-time handoff codes and short-lived network credentials remain in component memory. The app never puts them in URLs. Private receipts are retrieved by the owning customer. A voucher request carries its code only in a POST body. Idempotent purchase details and retry keys are scoped to the customer in tab/session storage so an ambiguous response can be retried safely; they are cleared after verified completion or successful sign out. Closing an expired unused quote requires a durable server fence with no payment attempt; client time alone never releases the saved purchase for another charge.

Preparing payment checkout is not payment confirmation. Queued access is not an active connection. The UI uses authoritative fulfillment/reversal/review state for purchases and recent verified hotspot accounting for connectivity. A disconnect request stays pending until confirmed by the service.

The balance panel reads one owner-bound `/api/usage` snapshot every five seconds while visible and online. It shows exact total remaining/used GB with an accessible meter, activated remaining allowance and queued allowance separately. The total is independent of paged bundle history and retains valid exhausted bundles in the denominator. It distinguishes balance-check time from **Last router report received**, explaining that router accounting usually arrives about every 60 seconds. Reservations never cause a second deduction.

Hidden/offline views pause requests. Reconnect/focus and redemption/payment trigger immediate checks; failures back off, retain the last good balance and label it stale. A 401 or owner changes clear private state and stop polling. A single snapshot also drives the connection panel. The app remains an offline preview when the cookie capability is false; installing a configured build does not enable the poll or bypass that gate.

Optional hotspot form submission uses the same exact `VITE_PAMOFI_ROUTER_FORM_ORIGINS` JSON origin array as the web app. The defaults allow the registered `https://hotspot.pasofi.onesa.eu` origin and its legacy `pamofi` hostname for a direct HTTPS POST. Technical details remain in a collapsed manual fallback. Other configured origins still require an explicit allowlist entry. The production mobile build emits a CSP limited to bundled scripts/styles, the configured API origin and any explicitly allowed router form origins. Neither the list nor a network credential enables a real hotspot by itself.

The selected HotSpot login page must use verified HTTPS and the PAP/User-Password RADIUS contract over the encrypted site tunnel. The current authority does not implement CHAP, MSCHAP or EAP. Manual copying into a default CHAP login page does not satisfy that contract; qualify the actual RouterOS login profile and packet attributes during physical acceptance.

## Independent customer source maintenance

The customer modules `CustomerAccess`, `LiveUsage`, `NetworkAccess`, `Recovery`, `Handoff`, `session` and the relevant `business` helpers are maintained copies in this project. The mobile API transport is intentionally separate because it validates the external HTTPS origin and credentialed CORS boundary. Keep customer behavior fixes synchronized with the web copy, then build and test each independent project. Do not introduce imports from the web build or backend implementation.

## Browser and native verification

Start the normal unconfigured mobile Vite server and run:

```sh
PAMOFI_CHROME_PATH=/path/to/chrome npm run test:browser
```

Set `PAMOFI_BASE_URL` if that preview is not at `http://localhost:5173`. The suite preserves two offline phone-layout journeys. Six additional tests start and stop their own local Vite fixture with a public `https://api.pamofi.test` configuration and intercepted synthetic API responses. They check capability refusal, credentialed transport and redemption, blocked-cookie refusal, gateway failure with offline fallback, preservation of a saved quote when an existing provider attempt prevents safe closure, and automatic remaining/used updates with offline retention, immediate reconnect and owner-change cleanup. They do not contact a commercial gateway.

The repository's strict `local-tools/verify.mjs --integration --browser` runs both frontend suites with no skipped/flaky tests and owns its local service processes. It remains separate from native build/device acceptance. Capacitor Android/iOS sync can also be checked in disposable copies of the native projects without changing tracked native assets. The completed [native CI checkpoint 41382739635](https://github.com/DruHustle/pamofi/actions/runs/41382739635) for source head `147fd7f25eaeb9e124e6e81e89e87cac8bfe2861` succeeded for both an API-unconfigured Android debug APK and an unsigned iOS simulator app, using merge source `bd4ef83322f1e86cc373207e468a184dc59c2e20`. See `NATIVE_BUILDS.md` for the earlier detailed artifact record and reproduction commands, and the pull request/Actions for subsequent exact-source results. Production signing, store release, physical-device behavior and native gateway qualification remain separate external acceptance steps.

## Development dependency override

The lockfile keeps Capacitor at 8.6.0 and narrowly overrides its CLI's `rimraf` dependency to use `glob` 14.0.3 with patched `minimatch`. This addresses [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) and [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) in development tooling. Keep the override until the upstream CLI resolves patched dependencies without it. Verify updates with `npm ci`, `npm audit`, the frontend build, and Capacitor sync in disposable native-project copies. Do not downgrade Capacitor to satisfy an audit suggestion.
