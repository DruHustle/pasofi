# PamoFi mobile frontend

This is the independent React/Capacitor project for iPhone and Android. It has its own package lock, source and build; it imports no web/frontend sibling or backend source. Node.js 22 or newer is required.

With no API configuration, the app remains a useful **offline preview** of example bundles and reviewed introductory help. It makes no account, purchase or connection requests. Prices shown in that preview are illustrative, not live offers.

The optional customer client supports the same customer capabilities as the web app: published bundles, vouchers, private agent receipts, hosted checkout/status, saved recovery, browser handoff and verified network status. Every operation remains disabled until a configured HTTPS gateway explicitly advertises a qualified mobile cookie boundary. The current backend deliberately returns `mobileCookies: false`; no mobile build setting can bypass that decision.

## Build and native projects

```sh
npm ci
npm test
npm run mobile:sync     # build and copy assets into both native projects
npm run mobile:ios      # open Xcode on macOS
npm run mobile:android  # open Android Studio
```

`npm test` checks TypeScript. After changing React or Capacitor configuration, run `npm run mobile:sync` before rebuilding native projects. Native web assets and generated Capacitor configuration are ignored by Git and regenerated. The app bundles its own frontend; never point a production WebView at a remote development server.

For iPhone, use Xcode with an installed iOS simulator runtime and select a simulator. A signed physical-device or App Store build requires the owner's Apple Developer team and signing configuration. The bundle ID `com.onesa.pamofi` is provisional until registered by the owner. The editable provisional icon is in `assets/app-icon.svg`.

For Android, use Android Studio, a compatible JDK 21 for Gradle and Android SDK Platform 36. The current Gradle 8.14 project does not support a JDK 25 runtime. A signed release requires an owner-controlled signing key, which must never be committed. Build and sync checks do not replace device/emulator testing.

## Configure the public HTTPS gateway

A qualified deployment can build its public gateway origin into the customer client:

```sh
VITE_PAMOFI_API_BASE_URL=https://api.example.invalid npm run mobile:sync
```

Only an HTTPS origin is accepted: no username, password, non-root path, query string or fragment. The setting is public build metadata, not a secret. Do not put service tokens, signing keys, router credentials or provider keys in any `VITE_` variable.

With a valid origin, the preview shows **My PamoFi**. That entry loads `/api/capabilities`. If the service is unavailable or `mobileCookies` is false, the client offers retry and the offline preview; it does not start account operations. A true capability permits only the individual features that the service also advertises.

The client sends explicit credentialed CORS requests to the configured origin, refuses API redirects, applies bounded timeouts, and verifies the current customer cookie after account creation, recovery and handoff. There is no bearer-token fallback in JavaScript storage. A service that accepts a mutation but fails to retain its cookie cannot be treated as an authenticated customer. This is covered in browser fault tests.

### Gateway/native qualification still required

Before a deployment may advertise `mobileCookies: true`, qualify its actual iOS and Android origins, cookie storage, SameSite/secure behavior, credentials/CORS policy and CSRF/origin checks together. Allow only the registered app/browser origins and credentials; do not replace origin checks with `*` or weaken them just to make a WebView request succeed. The current web-only backend origin/cookie policy has not been qualified for native app use. This repository's optional mobile client is prepared for that boundary, not evidence that it is already deployed.

Device acceptance must also cover app relaunch, interrupted requests, cookie blocking, logout/recovery, provider return navigation, clean browser handoff, captive Wi-Fi behavior, accessibility and short-lived hotspot sign-in. No live payment, SMS or Wi-Fi connection is claimed by the browser mocks.

## Customer privacy and state

Recovery keys, one-time handoff codes and short-lived network credentials remain in component memory. The app never puts them in URLs. Private receipts are retrieved by the owning customer. A voucher request carries its code only in a POST body. Idempotent purchase details and retry keys are scoped to the customer in tab/session storage so an ambiguous response can be retried safely; they are cleared after verified completion or successful sign out.

Preparing payment checkout is not payment confirmation. Queued access is not an active connection. The UI uses authoritative fulfillment/reversal/review state for purchases and recent verified hotspot accounting for connectivity. A disconnect request stays pending until confirmed by the service.

Optional hotspot form submission uses the same exact `VITE_PAMOFI_ROUTER_FORM_ORIGINS` JSON origin array as the web app. The default is a clean registered HTTPS login link plus manual copying. The production mobile build emits a CSP limited to bundled scripts/styles, the configured API origin and any explicitly allowed router form origins. Neither the list nor a network credential enables a real hotspot by itself.

## Independent customer source maintenance

The customer modules `CustomerAccess`, `NetworkAccess`, `Recovery`, `Handoff`, `session` and the relevant `business` helpers are maintained copies in this project. The mobile API transport is intentionally separate because it validates the external HTTPS origin and credentialed CORS boundary. Keep customer behavior fixes synchronized with the web copy, then build and test each independent project. Do not introduce imports from the web build or backend implementation.

## Browser and native verification

Start the normal unconfigured mobile Vite server and run:

```sh
PAMOFI_CHROME_PATH=/path/to/chrome npm run test:browser
```

Set `PAMOFI_BASE_URL` if that preview is not at `http://localhost:5173`. The suite preserves two offline phone-layout journeys. Four additional tests start and stop their own local Vite fixture with a public `https://api.pamofi.test` configuration and intercepted synthetic API responses. They check capability refusal, credentialed transport and redemption, blocked-cookie refusal, and gateway failure with offline fallback. They do not contact a commercial gateway.

The repository's strict `local-tools/verify.mjs --integration --browser` runs both frontend suites with no skipped/flaky tests and owns its local service processes. It remains separate from native build/device acceptance. Capacitor Android/iOS sync can also be checked in disposable copies of the native projects without changing tracked native assets. The native CI workflow builds unsigned test artifacts; signing, store release and native gateway qualification remain owner-controlled external acceptance steps.

## Development dependency override

The lockfile keeps Capacitor at 8.6.0 and narrowly overrides its CLI's `rimraf` dependency to use `glob` 14.0.3 with patched `minimatch`. This addresses [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) and [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) in development tooling. Keep the override until the upstream CLI resolves patched dependencies without it. Verify updates with `npm ci`, `npm audit`, the frontend build, and Capacitor sync in disposable native-project copies. Do not downgrade Capacitor to satisfy an audit suggestion.
