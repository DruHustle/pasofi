# Native customer connection

The iOS and Android customer apps use a private native transport to the existing
public Vercel frontend's `/api` proxy. The proxy continues to authenticate its
Oracle connection with its server-only credential. The apps do not connect
directly to Oracle, carry that credential, or require a new CORS policy.

This source implements the connection boundary. It does not enable a deployment,
qualify a physical device, sign a release, or enable payments or customer network
access. The native deployment switches default to false. Wallet merchant and
payment acceptance remain in [STRIPE_PAYMENTS.md](STRIPE_PAYMENTS.md).

## Transport and authority

`PasoFiCustomerApi` accepts a relative allowlisted customer path, a supported
method, bounded JSON, an optional operation idempotency key, and the expected
response type. It does not accept arbitrary URLs or headers. Its sole destination
is the exact HTTPS public frontend origin bundled at build time. Native code sets
that origin in the `Origin` header and adds `X-PasoFi-Native-Customer: 1`.

The marker selects a protocol; it is public and is not authentication. The Vercel
handler still checks the exact configured Host and Origin, obtains the caller's
address only from Vercel's platform metadata, and sends one TLS-verified request
to its fixed Oracle origin. It strips caller-supplied authority headers and does
not forward the native marker. Redirects are rejected at both network boundaries.
Browser requests retain their existing same-origin and CSRF checks, with no CORS
or `SameSite` relaxation.

The native plugin owns the host-bound session cookie and the session-creation
retry credential in private persistent storage. Neither value, `Set-Cookie`, nor
raw response headers cross the JavaScript bridge. The store is separate from
WebView and Capacitor's shared cookie stores. App restart can reuse a session or
retry an ambiguous creation with the original private key. A successful creation
is confirmed by a subsequent session read before its retry key is discarded.
Other customer operation keys retain their existing owner-bound retry behavior.
Explicit customer recovery keys and handoff codes remain the existing user-facing
recovery flow; they are never substituted for the server session authority.

Identity changes fence older requests and cookie writes. Logout records its
pending state before making the request, retains enough private state to retry an
ambiguous result, and prevents other private operations from continuing through
that uncertainty. After an app restart, a session read resumes that previously
requested sign-out with one bounded private deletion attempt. Only a confirmed
204 clears the stored session and creation key; the original read then reports
not authenticated. A failure retains pending logout for the next deliberate
session refresh, without creating a new account or entering a retry loop.
Changing a bundled API hostname never transfers its cookie to the new host;
explicit recovery or handoff is required.

## Deployment configuration

| Setting | Owner | Meaning |
| --- | --- | --- |
| `VITE_PAMOFI_API_BASE_URL` | Native build | Exact public Vercel HTTPS frontend origin. Capacitor sync bundles it as the plugin's public origin. Empty builds remain offline previews. |
| `PAMOFI_NATIVE_CUSTOMER_ENABLED` | Server-only Vercel environment | Must be exactly `true` to admit the native customer protocol. Defaults false. |
| `PAMOFI_NATIVE_CUSTOMER_QUALIFIED` | Server-only Vercel environment | Must also be exactly `true`; records the operator's acceptance decision for that deployment. Defaults false. |
| Existing `PAMOFI_PUBLIC_ORIGIN` and explicit aliases | Vercel and Oracle | Exact allowed public frontend origins. A native build must use one of these origins, and each request's Origin must match its own Host. |
| Existing Oracle origin and proxy credential | Server-only Vercel environment | Unchanged private Vercel-to-Oracle boundary. Never put these values in the app. |

Do not put a `VITE_` prefix on either server gate or any shared credential. An API
origin is a public build setting, not a credential. Ordinary previews remain
unconfigured. Connected qualification uses a separate staging frontend/backend,
database and secrets; it must not borrow production authority.

Marked `GET /api/capabilities` remains readable while the native gates are off.
Only this proxy response adds `nativeCustomerApiVersion: 1` and sets
`mobileCookies` from the two native flags. Every payment, sales, invoice and
network capability still comes from its owning backend. Ordinary browser and
direct backend capability responses are unchanged; the backend itself still
returns `mobileCookies: false`.

**`mobileCookies: true` records configured proxy qualification. It is not a
runtime device test or proof that a phone has a usable session.** The client must
still verify its current session, and signed-device acceptance remains required.
With either flag off, all other marked customer requests fail closed with
`native_customer_disabled`. The flags do not alter accounts, money or usage.

## Public customer protocol

| Customer operation | Allowed methods and scope |
| --- | --- |
| Capabilities, bundles, sites, usage, access history, help, payment methods | `GET`; only each route's bounded documented query fields |
| Session | `GET`, `POST`, `DELETE`; creation retry key generated and retained natively |
| Recovery status / setup / rotation / recovery | Existing `GET` status and `POST` mutations |
| Explicit handoff | `POST` creation or redemption |
| Orders | `GET` owner-bound list/recovery; `POST` creation; exact UUID status, checkout and unused-order closure routes |
| Customer invoices | `GET` owner-bound list/detail/PDF; existing `POST` private invoice-download token flow |
| Cash receipt pairing and vouchers | Existing create/read/cancel and redeem routes |
| Customer network | Existing sites/session reads and credential/disconnect requests; backend qualification gates remain authoritative |

The native allowlist excludes staff, administrator, internal-service and provider
callback paths, as well as arbitrary router operations. Mock-payment remains
available only through its existing backend demo gate; this lane adds no payment
authority. The native bridge rejects rewrite-reserved query fields. Vercel's
server handler still normalizes its own generated rewrite captures before
checking the exact customer route and query. Duplicate or unknown application
query fields and queries on mutations are rejected.

Only `__Host-pamofi_session` is forwarded from a marked request. A native response
may contain at most one session cookie, with `Secure; HttpOnly; SameSite=Lax;
Path=/` and no Domain. New cookie values are accepted only for successful session
creation, recovery or handoff redemption. A clear directive is accepted only for
successful session deletion. The native plugin repeats these checks and never
returns the header to JavaScript. Customer routes cannot install a staff cookie.

The proxy bounds request bodies to 32 KiB, responses to 1 MiB and the full upstream
operation to eight seconds. Native requests also have their own byte limits and
deadline. JSON is required except on the exact invoice PDF paths. Neither layer
automatically retries purchases or other ordinary mutations. The sole native
exception is the bounded resumption of a previously persisted pending sign-out
on a session read, as described above. A timeout can leave an outcome unknown;
the existing original-key recovery flow determines what happened.

## Qualification and acceptance

Run automated proxy tests with `npm --prefix pasofi-frontend/web run test:proxy`.
They use a local HTTP/TLS fixture and verify the default-off gates, exact route
and cookie restrictions, origin/client-address authority, protocol advertisement,
bounded responses and unchanged browser behavior. Native CI compiles the exact
Swift/Java implementation and runs its platform-independent policy tests. These
checks do not replace the following deployed-device record.

Use an isolated staging deployment and API-configured signed apps to exercise the
native lane before setting production qualification. Record the source revision,
build IDs, operating systems, configured public origin and observed results, with
no session cookies, retry keys, recovery keys or payment client secrets.

1. Confirm capabilities and session creation/read on both platforms. Restart the
   app and phone and verify the same customer remains authenticated. Inspect the
   bridge, WebView stores and logs for absence of private cookie/retry material.
2. Lose the first creation response and restart the app. Retry the original
   creation and prove that only one customer/session identity is recovered.
3. Exercise recovery and explicit handoff, including wrong/expired credentials.
   Delay an old request across an account change and verify it cannot restore old
   cookies or customer data.
4. Exercise logout, a lost logout response, explicit retry, and an app restart
   during pending logout. Confirm the revoked session cannot resume private work.
5. Reject a changed host, invalid certificate, redirect, malformed or extra
   cookie, staff/internal route, arbitrary header and forged caller address.
   Confirm the browser origin/CSRF checks still reject cross-site mutations.
6. Verify owner-bound usage, cash receipt/voucher and invoice PDF flows, including
   offline retention, original-key retry and rate-limit backoff.
7. Complete Stripe test checkout and supported wallet/3DS returns from the signed
   apps. Verify server-confirmed fulfillment, cancellation/retry and process
   restart through the original saved order. Record the actual available internet
   path for an unpaid HotSpot guest; do not infer it from backend provider egress.
8. Turn off either native gate and verify the public capability reports false and
   marked customer operations stop, while the browser and backend retain their
   independently qualified behavior.

Production signing, merchant provisioning, actual wallet authorization and the
physical HotSpot path remain separate acceptance requirements. This change does
not enable a gate or alter a router, provider account or live deployment.
