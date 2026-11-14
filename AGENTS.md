# PasoFi engineering and release rules

PasoFi is an Onesa Mobile product with independently built identity, prepaid-access,
network, notification and assistant services, web and Capacitor iOS/Android clients.
The consolidated source is `DruHustle/pasofi`. Preserve component boundaries,
existing data, migrations, concurrent edits and physical-router interlocks.

## Workspace paths

Keep extra worktrees in `local-tools/worktrees`, deployment evidence in
`local-tools/deployment-evidence`, release verification in
`local-tools/release-verification`, and operational migration records in
`local-tools/migrations`, all relative to this repository. Versioned database
schema migrations remain in the owning service's `migrations` directory.
Never put credentials, customer records, router exports or private drawings in Git,
logs or public artifacts. Record sanitized evidence and exact source hashes.

## Setup and verification

Use Node 24 and each package's lockfile. Read
`pasofi-backend/docs/TESTING.md` and `pasofi-frontend/mobile/NATIVE_BUILDS.md`.
`node pasofi-backend/local-tools/verify.mjs --install` builds all seven packages
and runs unit checks; its skipped database tests are not acceptance.
The critical local gate is `node pasofi-backend/local-tools/verify.mjs
--integration --browser` with five explicitly disposable loopback PostgreSQL
URLs and `PAMOFI_TEST_CONFIRM_ISOLATED=1`. Never point these tests at runtime data.
Run `npm --prefix pasofi-frontend/web run test:proxy` after proxy changes.
On macOS keep distinct module basenames; casing alone must not distinguish modules.

## Identity and payment boundaries

Onesa Identity owns human accounts, approval, suspension and PasoFi role grants.
A managed deployment uses the configured issuer at `auth.onesa.eu`, the PasoFi
API audience, browser-bound single-use Authorization Code/PKCE and signed stable
Onesa user IDs. Until the managed client, keys, links and staff bindings pass
qualification in that environment, the deployed legacy integration uses the Portal
issuer and live introspection. Legacy administrator access requires both existing
global-admin and PasoFi-admin grants plus MFA. A customer grant alone cannot
authorize a staff request.

Keep the original issuer namespace and proven stable Onesa UUID when resolving
existing PasoFi customers and site operators. Never merge identities by email.
Managed staff require a matching local approval, product role, assigned site
scope and recent provider MFA. Use the original token expiry to bound sessions
and native one-use transfers. Local guest recovery must never bypass revoked
federated access. Preserve guest purchase ownership, operator recovery controls,
router telemetry and network enforcement independently of human authentication.
The current native handoff uses a fixed system-browser origin and a two-minute
single-use transfer into an independently encrypted native session. Direct native
public-client PKCE and device qualification are separate release items.

Stripe fulfillment requires verified signed events plus fresh provider retrieval
bound to the stored amount, currency, account, customer, order, site and attempt.
Retain idempotency, delayed/duplicate event handling and reversal review. Native
PaymentSheet completion is not fulfillment. Keep unfinished mobile-money adapters
disabled. Sandbox, simulated NAS, signed native, physical router and production
results are separate evidence classes; none implies the others.

## Release and hardware

Use the existing repository PR/workflow and deployment process. Record actual
remote branch/rule state; the current checkout has main and topic branches, so do
not claim a dev/staging promotion exists without readback. Do not reset history,
force-push or overwrite unrelated work. Review exact changes before staging.
Use free resources; paid resources require explicit budget approval.

A successful JS bundle, debug APK or unsigned archive is not a store release.
Distribution requires the owner's signing identity, provisioning, merchant setup,
privacy/support/account-deletion review and physical-device qualification. Use
existing protected signing inputs; never invent production credentials.
Router changes require reachable equipment, a recoverable sanitized configuration,
site-specific uplink/management evidence and explicit owner operation. Preserve
physical actuation/network isolation and do not treat synthetic accounting as
customer internet access. Report missing hardware or credentials with an exact
next action and owner, then continue other reachable verification.
