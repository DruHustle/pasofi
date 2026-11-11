# Pasofi native build previews

The mobile source is `pasofi-frontend/mobile`. The checked-in native projects are `android` and `ios`; the Capacitor application ID is `com.onesa.pasofi`. There is no separate `pamofi-mobile` source folder.

The `Build PasoFi native previews` workflow compiles fresh web assets, runs the pinned Capacitor 8.6.0 synchronization, then independently builds Android and iOS. Each successful build checks the output on its runner and records its checksum in the job summary. Relevant main-branch pushes and manual runs also upload the binaries, source commit, toolchain version and archive checksums for three days. Run the workflow manually on a review branch when an installable preview is needed. A workflow definition or successful web build alone does not mean a native binary has been built: inspect the native job result and its artifact.

## Private native customer API

The local `PasoFiCustomerApi` plugin connects installed iOS/Android apps to the public Vercel API through a customer-only protocol. It is separate from Stripe's PaymentSheet: a compiled payment UI also needs an authenticated customer, owned order and backend checkout response before it can present a payment. The default CI builds leave the API origin empty and both server native flags remain off.

Build and sync with the same public HTTPS setting, for example `VITE_PAMOFI_API_BASE_URL=https://public.example.invalid npm run mobile:sync`. `capacitor.config.ts` embeds that origin in the native plugin configuration. JavaScript must match the installed origin and protocol1; missing/mismatched configuration never falls back to browser HTTP. No Oracle proxy token or signing secret belongs in this setting. [The connection guide](../../NATIVE_CUSTOMER_CONNECTION.md) specifies server enablement, qualification and rollback.

The bridge exposes `availability`, `request` and `cancel`. Requests accept an exact customer path/method, bounded JSON body, operation idempotency key and response type. The native code fixes the HTTPS origin, Origin header and public protocol marker. It refuses staff/admin/internal routes, duplicate or unexpected query keys, redirects and arbitrary request headers. Only validated JSON or bounded PDF data, HTTP status and retry timing are returned. Set-Cookie, Cookie and the private account-creation retry key never cross the JavaScript bridge.

iOS uses an isolated ephemeral URLSession with shared cookie, cache and credential stores disabled, and persists private state in origin-scoped Keychain data protected by `WhenUnlockedThisDeviceOnly`. Android uses an isolated HTTP client with private encrypted state protected by Android Keystore and AtomicFile in its no-backup directory. Neither implementation synchronizes credentials into WebView cookies or Capacitor's shared HTTP/cookie stores. A malformed or unavailable private store fails closed.

Account creation persists a native-generated retry key before sending; a matching GET/session must confirm the customer before that key is cleared. Explicit recovery/handoff and successful logout replace or clear the relevant state. Exact terminal `session_retry_expired`409 clears only the obsolete creation retry and does not start another request. Identity changes fence prior in-flight work and reject new work until completion. A persisted interrupted logout is resumed once by the next session read; another failure retains the pending state for a later deliberate retry.

CI runs Java policy/state tests and a pure Foundation Swift policy/state executable before building the actual plugins. Those tests cover route/query/authority-header limits, cookie transition validation, private creation confirmation, terminal retry handling and durable logout semantics. The iOS artifact includes the pure-test result. Device acceptance still must verify OS credential persistence and relaunch, interrupted requests, genuine TLS/redirect handling, no private cookie or retry material in bridge/log output, and customer identity throughout recovery/logout. A simulator build or synthetic bridge response does not establish these properties on a physical device.

## Native Stripe checkout

The local `PasoFiStripe` Capacitor bridge presents Stripe's native PaymentSheet. It supports cards, Apple Pay on eligible iOS devices and Google Pay on eligible Android devices. It does not depend on a React Native runtime or a Capacitor Stripe package with incompatible React peers.

| Native dependency | Exact version | Source pin |
| --- | --- | --- |
| Stripe iOS, `StripePaymentSheet` and `StripePayments` | 26.15.1 | [Official release](https://github.com/stripe/stripe-ios/releases/tag/26.15.1), commit `2f4547639a5aed18d39e4ba44c0ba684dab3161b` |
| Stripe Android | 23.25.2 | [Official release](https://github.com/stripe/stripe-android/releases/tag/v23.25.2), Maven `com.stripe:stripe-android:23.25.2` |
| Google Pay Android API | 20.0.0 | Maven `com.google.android.gms:play-services-wallet:20.0.0`, matching the [pinned Stripe dependency](https://github.com/stripe/stripe-android/blob/v23.25.2/dependencies.gradle) |

The iOS Stripe dependency belongs to the app's Xcode target, so `cap sync ios` does not overwrite it when regenerating `CapApp-SPM`. CI verifies the resolved Stripe version and commit alongside the existing Capacitor and Filesystem pins. The Android plugin is registered before `BridgeActivity.onCreate` builds the bridge, so PaymentSheet's activity-result launcher exists before the activity starts. Android CI runs the bridge input-validation unit tests before building the APK.

The JavaScript API is deliberately small:

```ts
availability({ publishableKey, testMode, merchantCountryCode,
  applePayMerchantId, googlePay }) // -> { applePay: boolean, googlePay: boolean }
present({ publishableKey, testMode, merchantCountryCode,
  applePayMerchantId, googlePay, clientSecret, merchantDisplayName: 'PasoFi' })
  // -> { status: 'completed' | 'cancelled' | 'failed' }
```

Both bridges reject a mismatched test/live key, malformed input and concurrent payment presentations. Stripe collects card details; the bridge returns neither card data nor PaymentIntent objects. The bridge does not log arguments, callbacks or SDK errors. Capacitor `loggingBehavior` is `none`, including debug builds, because Android's framework otherwise logs native-call arguments containing the client secret. Android uses the published release Stripe AAR without enabling SDK logging. iOS CI builds the unsigned simulator app in **Release**, and connected iOS device QA must also use Release: the pinned [Stripe analytics client](https://github.com/stripe/stripe-ios/blob/26.15.1/StripeCore/StripeCore/Source/Analytics/STPAnalyticsClient.swift) prints analytics payloads under `DEBUG`, independently of Capacitor logging. This compiles out debug analytics; it does not promise to suppress every SDK warning. Link and delayed payment methods are disabled in this integration. The backend's verified payment event determines fulfillment: a native `completed` result only starts order-status verification.

Wallet checks fall back to card checkout when the device is unavailable or readiness takes more than five seconds. The iOS PassKit check runs on a background queue: the [pinned Stripe API](https://github.com/stripe/stripe-ios/blob/26.15.1/StripeCore/StripeCore/Source/API%20Bindings/StripeAPI.swift) explicitly warns that a synchronous readiness check can stall. No wallet eligibility result qualifies a merchant account, signed build or real payment by itself.

### Apple Pay provisioning and return handling

The default build has no Apple merchant identifier and no Apple Pay entitlement. Do not substitute an invented identifier. For an Apple Pay device release, the operator must register their actual Apple Merchant ID, create the Apple Pay payment-processing certificate through Stripe's CSR flow, and provision the app's Apple Pay capability for that same identifier. See [Stripe's Apple Pay setup](https://docs.stripe.com/payments/accept-a-payment?payment-ui=mobile&platform=ios#enable-apple-pay).

Set these Xcode build settings for the signed configuration:

```text
PASOFI_APPLE_PAY_MERCHANT_ID = <actual registered Apple Merchant ID>
PASOFI_APPLE_PAY_ENTITLEMENTS = App/PasoFiStripe.entitlements
```

`CODE_SIGN_ENTITLEMENTS` references the second setting. The entitlement file and Info.plist receive the merchant identifier from the first. Set the backend's Apple merchant identifier to that same value. The bridge only advertises/configures Apple Pay when the backend identifier matches the installed build's identifier and entitlement setting, and PassKit reports availability. Signing/provisioning and Stripe certificate acceptance still require a real-device test.

iOS uses `com.onesa.pasofi://stripe-return`. Both normal scene callbacks and cold-start callbacks are consumed by Stripe before Capacitor forwards URL information to the WebView; the client-secret query is not sent to JavaScript. An app restarted during authentication recovers the saved order from the backend instead of trusting a return URL as proof of payment. The [official iOS PaymentSheet return-URL guide](https://docs.stripe.com/payments/accept-a-payment?payment-ui=mobile&platform=ios#set-up-a-return-url) explains this SDK callback flow.

### Google Pay provisioning and return handling

The Android manifest enables the Google Pay API. The backend explicitly controls whether Google Pay is offered and supplies the merchant's country. The bridge selects Google's test or production environment from the validated key mode. Google Pay production access requires the operator's real application and signing configuration; use the [Google Pay publication guide](https://developers.google.com/pay/api/android/guides/test-and-deploy/publish-your-integration). Test on a supported physical Android device with Google Wallet; an emulator compile does not verify wallet payment behavior. See [Stripe's Google Pay integration](https://docs.stripe.com/payments/accept-a-payment?payment-ui=mobile&platform=android#enable-google-pay).

Android PaymentSheet owns its SCA return activity and manifest filter, `stripesdk://payment_return_url/com.onesa.pasofi`. It does not expose the iOS `returnURL` configuration. The app retains the [SDK's supported return route](https://github.com/stripe/stripe-android/blob/v23.25.2/payments-core/AndroidManifest.xml), without a competing app filter.

### Acceptance still required for a connected release

Use the exact compiled revision and operator-configured test account on real iOS and Android devices. Verify a card success, decline, SCA challenge and cancellation; eligible/absent wallet behavior; app backgrounding or recreation during authentication; and recovery of the same saved order after an uncertain response. Confirm that entitlement activation occurs only after the backend verifies the payment and that retries cannot double-fulfill an order. Inspect debug device logs to verify that native arguments and payment secrets are absent. Apple Pay and Google Pay must each complete their own device test before being advertised as qualified.

The recorded artifacts below predate this Stripe bridge. Their success does not prove this new native code compiles or that payments work. Consult the payment PR's exact-source Android/iOS results before merging, and retain the separate device, signing and customer-cookie gates.

## Recorded native checkpoints

Both jobs succeeded in [workflow run 41378312413](https://github.com/DruHustle/pamofi/actions/runs/41378312413) for published head `64277e5e6d5442d3d4e335259a8da816f3ce621f`. GitHub compiled merge source `84a44994c025e625aa3c7ba5b40f8ddfa6a54225`, which is recorded with the artifacts. This checkpoint includes the cash-first customer flow and live usage display.

| Output | Artifact | Uploaded archive size | Uploaded archive SHA-256 |
| --- | --- | --- | --- |
| API-unconfigured Android debug APK | [13112510744](https://github.com/DruHustle/pamofi/actions/runs/41378312413/artifacts/13112510744) | 3,958,288 bytes | `2cfd6587d12d2397396b266b861194ad1cee99fcf9e2eb024b3c320601af58e2` |
| Unsigned iOS simulator app | [13112361645](https://github.com/DruHustle/pamofi/actions/runs/41378312413/artifacts/13112361645) | 1,507,604 bytes | `9e2c7a70a001874efd1a678bbe100a61f73ffcfab9ddff6367f7003fe8ef4be0` |

These artifacts expire on **16 November 2026**. Xcode 26.6 built the iOS preview for arm64 and x86_64 simulator. The earlier [run 41375913293](https://github.com/DruHustle/pamofi/actions/runs/41375913293), for source checkpoint `cd7399af`, also passed both jobs. Consult the pull request and Actions for subsequent exact-source results; artifact names and bundled source metadata identify each actual compiled revision. Native builds remain separate from cookie/device qualification and production signing.

### Earlier verified artifact record

Both native compilation jobs succeeded on **2026-11-02** in [workflow run 41373579356](https://github.com/DruHustle/pamofi/actions/runs/41373579356). The branch head was `649a5625dec4ec69715aa0225ae4a022ad407ddd`; the pull-request workflow compiled GitHub's merge commit `443cab073457bfdf238788daf08e38202c6af279`, which appears in the artifact names and source metadata.

| Output | Artifact | Uploaded archive size | Evidence |
| --- | --- | --- | --- |
| Android debug APK | [13110367862](https://github.com/DruHustle/pamofi/actions/runs/41373579356/artifacts/13110367862) | 3,949,802 bytes | Gradle 8.14.3 reported BUILD SUCCESSFUL; artifact upload completed. |
| Unsigned iOS simulator app | [13110560776](https://github.com/DruHustle/pamofi/actions/runs/41373579356/artifacts/13110560776) | 1,501,207 bytes | Xcode 26.6 reported BUILD SUCCEEDED for arm64 and x86_64 simulator; artifact upload completed. |

These GitHub artifacts expire on **2026-11-16**. The uploaded archive SHA-256 digests are `ada54f0961f0aa292fc2715bf21a1452da6eb7d06992e75052cc2b60bbc62f13` (Android) and `826e780d46dff3a61825ab95570b4ec453e1d16dcbfb8d89c79c0452b2c8e332` (iOS). Each archive also contains a checksum for its enclosed native binary/archive. The limitations below still apply: this run proves native compilation and packaging, not device behavior or connected production service acceptance.

## What the artifacts are

- Android: a debug APK signed with the disposable Android debug key. It is not a release-signed APK/AAB or a Google Play submission.
- iOS: an unsigned Release simulator `App.app` inside a tar archive, preserving executable permissions. It is not a device-installable IPA, TestFlight build or App Store submission. Use an iOS simulator compatible with the artifact's architecture and SDK. New artifacts record the build configuration explicitly; older checkpoints above used the previous simulator configuration.
- Both are **API-unconfigured previews**. The workflow explicitly leaves `VITE_PAMOFI_API_BASE_URL` empty, so the app cannot submit credentials, perform purchases, send SMS or connect through a backend. No provider or signing secrets are used.

The customer interface supports the private native HTTPS transport above. Configuration alone does not qualify physical-device storage, relaunch, session recovery, network transitions or accessibility. The server keeps `mobileCookies` false until both native flags are explicitly enabled; physical-device acceptance must be recorded separately from that configured gate and from native compilation.

## Toolchains and local commands

Capacitor 8 requires Node 22 or later, Xcode 26 or later and an iOS 15 minimum deployment target. The Android project uses Java 21, SDK 36 (minimum device API 24), AGP 8.13.2 and the checked-in Gradle 8.14.3 wrapper. The workflow uses Node 24.22.1, Java 21 and a macOS 26 runner whose Xcode version is checked at runtime.

From this directory, build Android after installing Java 21 and the Android 36 SDK:

```sh
npm ci
npm run build
npx --no-install cap sync android
cd android
bash ./gradlew --no-daemon :app:testDebugUnitTest :app:assembleDebug
```

For the unsigned iOS Release simulator build on a Mac with Xcode 26 or later:

```sh
npm ci
npm run build
npx --no-install cap sync ios
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -configuration Release -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath native-build/ios \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= \
  DEVELOPMENT_TEAM= ONLY_ACTIVE_ARCH=NO build
```

Official requirements: [Capacitor 8 migration guide](https://capacitorjs.com/docs/updating/8-0) and [environment setup](https://capacitorjs.com/docs/getting-started/environment-setup). The official GitHub [macOS 26 runner image](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-Readme.md) documents installed Xcode versions. Workflow actions are pinned to verified commits in the official `actions` repositories.
