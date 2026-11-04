# PasoFi web frontend

This is the independent React/Vite customer and staff web application. It has its own dependencies and build; it imports no backend source or mobile package. Node.js 22 or newer is required.

```sh
npm ci
npm test
npm run test:proxy
npm run build
npm run dev -- --host 127.0.0.1
```

`npm test` checks TypeScript. `npm run test:proxy` tests the Vercel proxy over real local HTTP/TLS and requires OpenSSL. Browser journeys are a separate acceptance gate, described below. A static deployment without the API gateway remains a presentation/demo surface; building the frontend does not configure payment providers, SMS, customer cookies, or a hotspot.

## Customer experience

The application reads `/api/capabilities` before offering operational tools. The server must still authorize every action. The immediate purchase path is cash paid to an authorized agent, with a private paired receipt and explicit voucher redemption. Published cash-sale bundle cards stay usable when online checkout is disabled. Online payment is secondary and remains capability-gated; external digital checkout cannot be enabled in the current runtime. Pesepay registration/activation has been removed; the dormant EcoCash contract adapter cannot settle a payment or fulfill access. Later direct provider/bank integration requires qualified merchant evidence; see [direct payment preparation](../../pasofi-backend/services/prepaid-access-service/DIRECT_PAYMENTS.md). Demo sales, provider simulations, queued allowance and verified hotspot accounting remain distinct visible states.

| Area | Behavior |
| --- | --- |
| Bundles and help | Published catalogue with loading, empty, unavailable and retry states. Reviewed FAQ search runs locally; typed questions are not sent to a model or support service. Candidate catalogues retain the explicit demo journey. |
| Voucher redemption | A customer enters a private voucher in a POST body. The server atomically redeems it into that customer's queue. Retrying the same code cannot create a second bundle. |
| Private agent receipts | The customer's browser creates a short-lived pairing code, then polls that owned pairing while visible and waiting. The agent confirms the exact cash amount before issuing. The receipt appears automatically with agent-attested cash evidence and one explicit redemption action. Only the paired account can retrieve its receipt/voucher; neither appears in the URL. |
| Online checkout | Enabled methods, exact price and provider limits are loaded from the API. An unfinished checkout restores its original details after a lost response or reload. Hosted checkout links must use HTTPS. Only authoritative fulfillment status is presented as a verified purchase; reversal and accounting review have separate messages. An expired unused quote can be closed only by the server under the same order lock as payment initiation, with no attempts, charges or entitlement; only that verified durable fence releases the saved purchase for a fresh quote. |
| Recovery and handoff | Recovery keys and two-minute one-use browser handoff codes remain in component memory. A handoff uses a clean `/handoff` page and separately pasted code with explicit consent. Both recovery and handoff verify the resulting customer cookie before accepting the account. |
| Live remaining data | Whole-account remaining/used GB, an accessible usage meter, activated allowance and queued allowance. Totals cover all valid bundles, including exhausted ones, regardless of history pagination. Updates run every five seconds while visible and online; router report receipt time and balance-check time are distinct. |
| Network status | Sign-in credentials remain in memory and expire. Preparing credentials never means connected. Connectivity consumes the same consistent snapshot as the balance and requires the service's recent verified hotspot accounting state; there is no duplicate connection poll. A disconnect request remains pending until the service reports the final result. |
| Sign out | The server must revoke the current session successfully. Then account views, recovery/purchase retry state and tab-local operation drafts are cleared. Signing out of the account does not imply an active hotspot session has ended. |

A customer session is anonymous until the customer saves recovery details. Keep those details before signing out. The app never asks customers to give recovery keys or authenticator secrets to an agent or support worker.

### Live usage semantics

`/api/usage` returns one owner-bound ledger snapshot. Remaining data already reflects recorded upload/download usage. Reservations are displayed separately, can survive a bundle expiry/reversal under review, and are never subtracted a second time. Queued data is included in the total and also shown separately; validity starts only on successful hotspot activation. The UI does not invent a monetary wallet balance.

Polling pauses in hidden, offline or inactive views. Focus/online and successful redemption/payment trigger a fresh check. Errors use bounded backoff and Retry-After where available; a stale/offline label accompanies retained last-good values. Malformed responses cannot zero the balance. The label **Last router report received** describes service receipt time, not the original router measurement; the usual accounting interval is shown beside it. No per-poll page spinner or repeated screen-reader balance announcement is used.

Customer identity, request generations and aborts fence late responses. A 401 or owner mismatch clears private state and stops polling. Bounded visible entitlement IDs keep cards current without refetching all history, and monotonic counters prevent delayed history reads from replacing newer accounting. The network panel uses this same snapshot and refuses late credential responses after verification becomes stale.

## Staff workspaces

Staff use password authentication plus a time-based authenticator. New applications remain pending after MFA setup. A verified MFA response must match the subsequent session's account and version; a blocked cookie or a different surviving staff cookie cannot silently select another account. Supported tabs receive account-change broadcasts and clear stale private views. Mutations also check the current account and permission version immediately before sending.

| Role | Available workspace |
| --- | --- |
| Pending staff | Authenticator setup, current approval status and sign out. No sales or administration controls. |
| Agent | Assigned sites, inventory, exact cash amount/currency confirmation, private paired receipt or separately configured SMS delivery, and sales/delivery history. Immutable evidence identifies the confirming agent/time; it is never labeled payment-provider verification. A pending sale restores its exact original request and key, including a legacy body without cash evidence; retries never require a second cash payment. Only explicitly serialized, rolled-back domain rejections unlock corrections; gateway errors and unknown outcomes keep the same key. |
| Support | Sales and delivery evidence within assigned sites. No voucher reveal, sale, inventory allocation, account approval or resend control. |
| Administrator | Versioned staff decisions with reasons, site assignment, session revocation, site creation, approved-agent inventory allocation, immutable bundle versions and publication, sales/delivery review, staff audit history and unresolved network accounting reviews. |

SMS submission is not delivery. The UI uses the provider-confirmed delivery result and exposes charges only when reported. Agent/admin resend requests require a reason and explicit acknowledgement that a new provider charge may apply. Unknown or unresolved attempts cannot be automatically resent. Support can review evidence but cannot request a resend.

Network accounting review requires fresh independent router absence, credential fencing, a recorded evidence reference, and exact final cumulative upload/download counters. The UI refuses counters below observed usage or above the existing reservation; the backend performs authoritative checks. It offers no estimate or balance write-off shortcut.

## Local API boundary

The browser calls same-origin `/api/` routes with cookies. Session credentials stay in HttpOnly cookies. The Vite development proxy, Nginx configuration and Vercel function explicitly allow public customer, staff and administration paths; they do not expose service-internal routes. Unknown `/api/` paths return JSON 404 instead of frontend HTML. Public query strings, request bodies, Origin and the required session cookies reach the owning service.

The Vite proxy supports server-only variables:

| Variable | Default |
| --- | --- |
| `PAMOFI_IDENTITY_URL` | `http://localhost:18081` |
| `PAMOFI_PREPAID_URL` | `http://localhost:18082` |
| `PAMOFI_ASSISTANT_URL` | `http://localhost:18085` |

The backend `PUBLIC_ORIGIN` must exactly match the browser origin, including the port. These variables are not browser configuration and do not create Vercel production routing.

```sh
PAMOFI_IDENTITY_URL=http://localhost:28181 npm run dev -- --host 127.0.0.1 --port 5178 --strictPort
```

The Nginx image uses the private Docker service names. Build `dist` before building the image. A production deployment also needs the private backend network, TLS gateway, correct origin, secrets and provider/router qualification; see the backend production infrastructure documentation. The runtime image is pinned to `nginx:1.30.6-alpine3.24`.

## Vercel frontend with an Oracle backend

Set the Vercel project's **Root Directory** to `pasofi-frontend/web`, select the **Vite** framework and a supported Node.js version of at least 22, and deploy this directory with its `vercel.json`. The checked-in settings use `npm ci`, `npm run build` and output directory `dist`. Vercel separately builds the root `api/gateway.mjs` Node function and traces its server-only import from `server/oracle-proxy.mjs`. Uploading only `dist` omits that function. This uses Vercel's documented [root `api/` function layout](https://vercel.com/docs/functions/runtimes/node-js#create-a-nodejs-function-in-api) and [`.mjs` entry point rules](https://vercel.com/docs/functions/runtimes/node-js/advanced-node-configuration) alongside the [Vite static build](https://vercel.com/docs/frameworks/frontend/vite).

`vercel.json` rewrites `/api/:path*` to that function. The browser continues to call its own frontend origin; the function contacts the configured Oracle HTTPS gateway. The function checks the original or rewritten route against the same explicit public route/method allowlist. Its reserved `__pamofi_path` query value cannot select an arbitrary URL, internal endpoint or unsupported method; duplicated or conflicting values are rejected.

Configure these **server-side Vercel environment variables** in the appropriate project environment before redeploying:

| Variable | Required value |
| --- | --- |
| `PAMOFI_PUBLIC_ORIGIN` | The exact browser origin, such as `https://app.example.com`. Use lowercase DNS, HTTPS, no trailing slash, path, port, query or credentials. The browser Host and every mutation's Origin must match. |
| `PAMOFI_ORACLE_API_ORIGIN` | The distinct exact Oracle gateway origin, such as `https://api.example.com`, with a publicly trusted TLS certificate. The same strict origin format applies. The function never reads an upstream target from a request. |
| `PAMOFI_VERCEL_PROXY_TOKEN` | A fresh 32-byte random secret encoded as exactly 64 lowercase hexadecimal characters. Store the same value as Oracle's `vercel_proxy_token` secret. Generate and transfer it through the deployment secret workflow; do not commit or print it in deployment logs. |
| `NODEJS_HELPERS` | `0`. Also fixed as a nonsecret function runtime setting in `vercel.json`. This disables Vercel's request/response helpers so the proxy can read the bounded raw Node request stream and preserve exact request bytes. |

Vercel's [advanced Node configuration](https://vercel.com/docs/functions/runtimes/node-js/advanced-node-configuration#disabling-helpers-for-nodejs) documents `NODEJS_HELPERS=0`; the [function environment property](https://vercel.com/docs/project-configuration/vercel-json#env) passes this checked-in flag at invocation. Keep the matching project environment setting as well. Vercel supplies its `VERCEL=1` system variable; do not turn an arbitrary public Node server into a trusted ingress by setting it yourself. A missing/invalid configuration, missing platform client address or mismatched host produces a private JSON error before an Oracle request is sent.

These variables must never use a `VITE_` prefix. They are not browser API URLs or client secrets. The example environment file deliberately leaves the deployment origins and token empty. Ordinary previews must have no production token or Oracle origin. A functional preview requires its own explicitly configured stable frontend origin and separate staging backend/token; random preview aliases fail the host/origin checks. Backend capabilities remain authoritative, so proxy setup does not enable payments, SMS or physical hotspot access.

Configure Oracle with the [Vercel/Oracle production overlay](../../pasofi-backend/infra/production/VERCEL_ORACLE.md). The backend's `PUBLIC_ORIGIN` is the Vercel browser origin while Oracle's public TLS host remains its own host. The Oracle gateway authenticates `X-PamoFi-Proxy-Token` before admitting public API traffic and removes the proxy credentials before forwarding to private services. Keep the API off the direct unauthenticated gateway configuration. Rotate the token on both sides in a coordinated deployment; a mismatch fails closed.

The proxy derives a single canonical IPv4/IPv6 address exclusively from Vercel's [platform `x-vercel-forwarded-for` header](https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for), sends it as `X-PamoFi-Client-IP`, and replaces all inbound trust headers. It never trusts browser-supplied `X-Forwarded-For`, `X-Real-IP`, authorization or internal service headers. IPv4-mapped IPv6 becomes dotted IPv4 so the Oracle gateway uses the same identity representation. Adding another proxy in front of Vercel or changing Vercel's Trusted Proxy settings requires a new client-identity qualification; the tested topology is browser directly to Vercel.

The handler preserves status, public query strings, JSON bytes, Origin, idempotency keys, and separate `Set-Cookie` headers including expiry/clearing. Only the three production PamoFi cookies pass through. Each returned session cookie must remain host-only `Secure; HttpOnly; SameSite=Lax; Path=/`; no cross-origin CORS or cookie-domain relaxation is introduced. Every proxy response and error carries `no-store` for browsers and CDNs. Requests are limited to 32 KiB, upstream responses to 1 MiB, and the complete operation to eight seconds within a ten-second Vercel function limit. TLS validation remains enabled; redirects are not followed and mutations are never retried by the proxy. A timeout may leave an operation's result unknown, so existing client workflows retain their original idempotency key for an explicit retry.

### Vercel qualification

`npm run test:proxy` starts isolated loopback HTTP/TLS listeners and verifies routing, empty-body session idempotency, cookie issuance/clearing, origin/host enforcement, spoofed and duplicate headers, client IP normalization, byte limits, deadline cancellation, TLS trust and hostname failures, redirect refusal, and private errors. It also exercises both original and rewritten URL forms. The Oracle overlay lab then runs this actual handler against the full TLS gateway and services.

Before accepting a real deployment, verify the function is present in Vercel's build output, then run the documented production smoke checks on the configured frontend host: anonymous cookie creation/read, staff authentication, a nonfinancial usage read, logout clearing, and rejection of direct Oracle requests without the shared secret. Confirm an API-unconfigured preview returns private JSON errors and never reaches production. Those checks require actual deployment configuration; local proxy/stack tests do not claim that a Vercel project, Oracle host, DNS or TLS certificate has been provisioned.

### Router sign-in

The default sign-in flow links to the registered HTTPS hotspot page and lets the customer copy short-lived credentials manually. Credentials are never put in a link, URL fragment, browser storage, or query parameter.

The qualified router page must use HTTPS credential login and produce the RADIUS `User-Password` (PAP) contract that PamoFi implements, with RADIUS carried inside the private encrypted site tunnel. The optional form below sends the same username/password fields over HTTPS; it does not perform CHAP. RouterOS's default `http-chap,cookie` profile is therefore not a supported setup. Prepare the trusted-certificate `login-by=https` profile and verify its actual request attributes before enabling customer sign-in; plaintext `http-pap`, CHAP, EAP and MSCHAP are outside the supported flow. See the [RouterOS preparation contract](../../pasofi-backend/pasofi-routeros/README.md#hotspot-authentication-contract).

Optional form POST is disabled unless the build provides an exact JSON array of qualified HTTPS origins, for example:

```sh
VITE_PAMOFI_ROUTER_FORM_ORIGINS='["https://hotspot.example.invalid"]' npm run build
```

The returned login URL must match the selected registered site's URL, and its origin must match the array before a form appears. The deployment's CSP `form-action` must separately permit the same exact origin. The checked-in Nginx and Vercel CSPs permit only `'self'`; they intentionally do not allow arbitrary `https:` form targets. This is a public origin allowlist, never a place for a router password or service secret.

## Verification

The full acceptance command, from the repository root, is:

```sh
node pasofi-backend/local-tools/verify.mjs --integration --browser
```

Follow [the isolated database setup](../../pasofi-backend/docs/TESTING.md) first. The runner owns temporary API/Vite processes, applies migrations and passes matching origins. Set `PAMOFI_CHROME_PATH` when using an installed compatible Chromium executable.

The complete web suite includes real demo purchase/recovery/sign-out journeys, mocked response-loss and permission failures, and a real three-browser commerce journey: administrator MFA, new staff application and MFA, approval, site allocation, agent cash attestation, private customer receipt, voucher redemption into a queued allowance, and an automatically observed cumulative usage update from an isolated service-owned accounting fixture. Disposable staff identities use unique `@staff.pamofi.test` addresses; no mailbox or live email is involved. The commerce test requires `PAMOFI_TEST_CONFIRM_ISOLATED=1`, the isolated identity/prepaid URLs and the same `STAFF_MFA_ENCRYPTION_KEY` as the API. It invokes service-owned guarded fixture CLIs in separate processes, never imports backend source, and removes only its uniquely named fixtures. It fails rather than silently skipping when the isolated configuration is missing.

For focused UI fault checks against an existing local Vite server:

```sh
PAMOFI_BASE_URL=http://localhost:5178 PAMOFI_CHROME_PATH=/path/to/chrome npm run test:browser -- tests/resilience.spec.ts tests/workspaces.spec.ts tests/usage.spec.ts
```

The completed local strict run on 2 November 2026 passed all 43 web cases and 8 mobile cases, within 168 integration/browser tests across the seven projects, with zero skipped or pending cases. See [the review record](../../pasofi-backend/docs/REVIEW_2026-11-02.md) for separate historical CI/native evidence and the pull request/Actions for subsequent exact-source results.

Reports and screenshots live in Playwright's ignored `test-results` directory. Do not run real journey tests against production or shared data. Passing synthetic acceptance does not establish live provider delivery, physical RouterOS operation, native phone cookie behavior, production backup recovery, or deployment readiness.
