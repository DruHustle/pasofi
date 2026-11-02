# PamoFi web frontend

This is the independent React/Vite customer and staff web application. It has its own dependencies and build; it imports no backend source or mobile package. Node.js 22 or newer is required.

```sh
npm ci
npm test
npm run build
npm run dev -- --host 127.0.0.1
```

`npm test` checks TypeScript. Browser journeys are a separate acceptance gate, described below. A static deployment without the API gateway remains a presentation/demo surface; building the frontend does not configure payment providers, SMS, customer cookies, or a hotspot.

## Customer experience

The application reads `/api/capabilities` before offering operational tools. The server must still authorize every action. Demo purchases, provider simulations, actual provider status, queued bundles, and verified hotspot connectivity are separate visible states.

| Area | Behavior |
| --- | --- |
| Bundles and help | Published catalogue with loading, empty, unavailable and retry states. Reviewed FAQ search runs locally; typed questions are not sent to a model or support service. Candidate catalogues retain the explicit demo journey. |
| Voucher redemption | A customer enters a private voucher in a POST body. The server atomically redeems it into that customer's queue. Retrying the same code cannot create a second bundle. |
| Private agent receipts | The customer's browser creates a short-lived pairing code. The agent enters that code while recording a sale. Only the paired account can retrieve its receipt and voucher. Neither appears in the URL. |
| Online checkout | Enabled methods, exact price and provider limits are loaded from the API. An unfinished checkout restores its original details after a lost response or reload. Hosted checkout links must use HTTPS. Only authoritative fulfillment status is presented as a verified purchase; reversal and accounting review have separate messages. An expired unused quote can be closed only by the server under the same order lock as payment initiation, with no attempts, charges or entitlement; only that verified durable fence releases the saved purchase for a fresh quote. |
| Recovery and handoff | Recovery keys and two-minute one-use browser handoff codes remain in component memory. A handoff uses a clean `/handoff` page and separately pasted code with explicit consent. Both recovery and handoff verify the resulting customer cookie before accepting the account. |
| Network status | Sign-in credentials remain in memory and expire. Preparing credentials never means connected. Connectivity requires the service's recent verified hotspot accounting state. A disconnect request remains pending until the service reports the final result. |
| Sign out | The server must revoke the current session successfully. Then account views, recovery/purchase retry state and tab-local operation drafts are cleared. Signing out of the account does not imply an active hotspot session has ended. |

A customer session is anonymous until the customer saves recovery details. Keep those details before signing out. The app never asks customers to give recovery keys or authenticator secrets to an agent or support worker.

## Staff workspaces

Staff use password authentication plus a time-based authenticator. New applications remain pending after MFA setup. A verified MFA response must match the subsequent session's account and version; a blocked cookie or a different surviving staff cookie cannot silently select another account. Supported tabs receive account-change broadcasts and clear stale private views. Mutations also check the current account and permission version immediately before sending.

| Role | Available workspace |
| --- | --- |
| Pending staff | Authenticator setup, current approval status and sign out. No sales or administration controls. |
| Agent | Assigned sites, available inventory, exact-price sales with private receipt or configured SMS delivery, recent sales, private receipts and scoped delivery status. A pending sale restores its original request and idempotency key for safe retry. Only explicitly serialized, rolled-back domain rejections unlock corrections; gateway errors and unknown outcomes keep the same key. |
| Support | Sales and delivery evidence within assigned sites. No voucher reveal, sale, inventory allocation, account approval or resend control. |
| Administrator | Versioned staff decisions with reasons, site assignment, session revocation, site creation, approved-agent inventory allocation, immutable bundle versions and publication, sales/delivery review, staff audit history and unresolved network accounting reviews. |

SMS submission is not delivery. The UI uses the provider-confirmed delivery result and exposes charges only when reported. Agent/admin resend requests require a reason and explicit acknowledgement that a new provider charge may apply. Unknown or unresolved attempts cannot be automatically resent. Support can review evidence but cannot request a resend.

Network accounting review requires fresh independent router absence, credential fencing, a recorded evidence reference, and exact final cumulative upload/download counters. The UI refuses counters below observed usage or above the existing reservation; the backend performs authoritative checks. It offers no estimate or balance write-off shortcut.

## Local API boundary

The browser calls same-origin `/api/` routes with cookies. Session credentials stay in HttpOnly cookies. Both the Vite development proxy and the Nginx configuration explicitly allow public customer, staff and administration paths; they do not expose service-internal routes. Unknown `/api/` paths return JSON 404 instead of frontend HTML. Query strings, request bodies, Origin and cookie headers are preserved for the owning service.

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

### Router sign-in

The default sign-in flow links to the registered HTTPS hotspot page and lets the customer copy short-lived credentials manually. Credentials are never put in a link, URL fragment, browser storage, or query parameter.

Optional form POST is disabled unless the build provides an exact JSON array of qualified HTTPS origins, for example:

```sh
VITE_PAMOFI_ROUTER_FORM_ORIGINS='["https://hotspot.example.invalid"]' npm run build
```

The returned login URL must match the selected registered site's URL, and its origin must match the array before a form appears. The deployment's CSP `form-action` must separately permit the same exact origin. The checked-in Nginx CSP permits only `'self'`; it intentionally does not allow arbitrary `https:` form targets. This is a public origin allowlist, never a place for a router password or service secret.

## Verification

The full acceptance command, from the repository root, is:

```sh
node pamofi-backend/local-tools/verify.mjs --integration --browser
```

Follow [the isolated database setup](../../pamofi-backend/docs/TESTING.md) first. The runner owns temporary API/Vite processes, applies migrations and passes matching origins. Set `PAMOFI_CHROME_PATH` when using an installed compatible Chromium executable.

The complete web suite includes real demo purchase/recovery/sign-out journeys, mocked response-loss and permission failures, and a real three-browser commerce journey: administrator MFA, new staff application and MFA, approval, site allocation, agent sale, private customer receipt and voucher redemption. The commerce test requires `PAMOFI_TEST_CONFIRM_ISOLATED=1`, the isolated identity/prepaid URLs and the same `STAFF_MFA_ENCRYPTION_KEY` as the API. It invokes service-owned guarded fixture CLIs in separate processes, never imports backend source, and removes only its uniquely named fixtures. It fails rather than silently skipping when the isolated configuration is missing.

For focused UI fault checks against an existing local Vite server:

```sh
PAMOFI_BASE_URL=http://localhost:5178 PAMOFI_CHROME_PATH=/path/to/chrome npm run test:browser -- tests/resilience.spec.ts tests/workspaces.spec.ts
```

Reports and screenshots live in Playwright's ignored `test-results` directory. Do not run real journey tests against production or shared data. Passing synthetic acceptance does not establish live provider delivery, physical RouterOS operation, native phone cookie behavior, production backup recovery, or deployment readiness.
