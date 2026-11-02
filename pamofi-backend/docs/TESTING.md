# Testing PamoFi

The repository has seven independent Node projects: five backend services, the web interface, and the mobile application. Run the repository verification tool from any directory; it resolves all project paths relative to its own file. It never imports application code across project boundaries.

## Choose the verification level

| Command or check | What it verifies | What it does not establish |
| --- | --- | --- |
| `node pamofi-backend/local-tools/verify.mjs --install` | Installs each project's locked dependencies; builds all seven projects; runs service tests without test databases | Database-dependent cases are explicitly reported as skipped; no browser or integration acceptance |
| `node pamofi-backend/local-tools/verify.mjs --integration` | Runs each service's migrations; starts five owned loopback demo processes; runs all service tests against dedicated PostgreSQL databases, including authenticated cross-service calls and the TLS RADIUS adapter | No browser, physical router, live provider, or Docker backup acceptance |
| `node pamofi-backend/local-tools/verify.mjs --integration --browser` | Adds real customer/staff/agent web journeys plus web/mobile fault mocks and offline checks against owned Vite/API processes | No real payment, SMS, hotspot, native phone build, or production acceptance |
| The container labs below | Actual FreeRADIUS packets, disposable encrypted backup/restore, private staging and production TLS/runtime configuration | No qualification of a physical router, commercial provider account, or off-site backup destination |
| `node --test pamofi-backend/infra/remote-access/*.test.mjs` | Offline reachability assessment, direct/hub configuration validation, narrow routes/firewalls and output protection | No live WireGuard handshake, public-endpoint reachability or physical RouterOS command acceptance |
| `npm --prefix pamofi-frontend/web run test:proxy` | Actual HTTP/TLS requests through the server-only Vercel handler, strict origins and routes, client-IP metadata, cookies, timeouts and error handling | No Vercel edge deployment or public Oracle certificate qualification |
| The Vercel, site-link, RADIUS-production and operations checks below | Split-host configuration, private RADIUS binding, outbound site-link scope, production transport and monitoring contracts | No physical NAS, Starlink tunnel handshake or public production deployment |

Add `--install` to either integration command when dependencies have not yet been installed. Node.js 22 or later is required; CI uses Node 24.22.1. The integration tests require OpenSSL for their temporary TLS certificates. The browser gate needs Playwright Chromium or an explicit `PAMOFI_CHROME_PATH` to an installed compatible Chrome executable.

**Integration mode fails if a database variable is missing, a database URL is not loopback, any service test is skipped or marked pending, or a service exits unexpectedly.** The browser gate also rejects skipped and flaky cases. A successful unit-only run is not a substitute for either gate.

## Create disposable databases

Use a separate local PostgreSQL cluster that contains only synthetic PamoFi test data. Never use a live, staging, shared development, or SSH-forwarded production database. Tests create synthetic customer sessions, purchases, and delivery records. Some tests deliberately terminate their own uniquely named idle database connections to verify recovery. The runner does not drop databases or clear existing application data.

One example with Docker, from the repository root:

```sh
PAMOFI_VERIFY_CONTAINER="pamofi-verification-$(date +%s)"
docker run --rm --detach --name "$PAMOFI_VERIFY_CONTAINER" \
  --publish 127.0.0.1:55439:5432 \
  --env POSTGRES_PASSWORD=disposable_test_only \
  postgres:17.11-alpine3.23

for attempt in $(seq 1 30); do
  if docker exec "$PAMOFI_VERIFY_CONTAINER" pg_isready -U postgres -d postgres; then break; fi
  sleep 1
done
docker exec -i "$PAMOFI_VERIFY_CONTAINER" \
  psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < pamofi-backend/infra/postgres/init.sql
```

The initializer creates five databases with separate roles and inserts the candidate catalogue into the prepaid test database. Its fixed passwords and published bundles are for disposable tests only. The service migration commands then create and verify each owned schema; the runner never crosses database ownership to apply migrations.

Set all five connection URLs explicitly:

```sh
export PAMOFI_TEST_CONFIRM_ISOLATED=1
export PAMOFI_TEST_IDENTITY_DATABASE_URL='postgresql://pamofi_identity:demo_only_change_me@127.0.0.1:55439/pamofi_identity'
export PAMOFI_TEST_PREPAID_DATABASE_URL='postgresql://pamofi_prepaid_access:demo_only_change_me@127.0.0.1:55439/pamofi_prepaid_access'
export PAMOFI_TEST_NETWORK_DATABASE_URL='postgresql://pamofi_network:demo_only_change_me@127.0.0.1:55439/pamofi_network'
export PAMOFI_TEST_NOTIFICATION_DATABASE_URL='postgresql://pamofi_notification:demo_only_change_me@127.0.0.1:55439/pamofi_notification'
export PAMOFI_TEST_ASSISTANT_DATABASE_URL='postgresql://pamofi_assistant:demo_only_change_me@127.0.0.1:55439/pamofi_assistant'

node pamofi-backend/local-tools/verify.mjs --install --integration
```

Use an explicit local port and a separate database for each URL. The runner accepts `127.0.0.1`, `localhost`, or `::1`, and rejects connection URL parameters and fragments so a parameter cannot replace the loopback host. `PAMOFI_TEST_CONFIRM_ISOLATED=1` is your assertion that these are disposable databases; a local address alone cannot identify a forwarded production database.

For browser verification, install Chromium once, then run the complete gate:

```sh
(cd pamofi-frontend/web && npx --no-install playwright install chromium)
node pamofi-backend/local-tools/verify.mjs --integration --browser
```

On Linux, Playwright may also need system libraries: use `npx --no-install playwright install --with-deps chromium` on a disposable CI runner or another machine where installing those packages is appropriate. To reuse a compatible installed Chrome, set `PAMOFI_CHROME_PATH` instead.

The runner assigns temporary loopback ports, sets the matching frontend proxies and identity origin, and checks the readiness of the processes it started. It strips inherited provider credentials and service configuration, keeps live digital providers disabled and disables the background outbox dispatcher, and uses synthetic service keys. Provider tests use local fakes; they do not initiate actual payments or send SMS. The RADIUS adapter tests use temporary TLS certificates and simulated NAS contexts.

Web and mobile browser results are written to each project's ignored `test-results/verification-summary.json`; Playwright also keeps failure traces or screenshots requested by the suites there. The terminal prints per-project results and the final number of passing tests. The web suite includes an actual three-context MFA/approval/allocation/cash-sale/private-receipt/redemption journey. It then invokes a service-owned synthetic accounting fixture and waits for the visible balance to update automatically, without clicking Refresh. Unique disposable staff identities use the reserved `staff.pamofi.test` domain; no mailbox or live email is used. Guarded service-owned fixture CLIs receive isolated database settings only in the test process; test code does not import backend implementation. The mobile suite covers two offline layouts and six configured HTTPS API mocks, including cookie refusal, capability gating, saved-quote protection, automatic usage updates, offline retention/reconnect and owner change. Web mocks additionally cover whole-account totals beyond paged history, malformed data, expired/exhausted allowance, failure backoff, hidden-view pauses and delayed sensitive responses. Its additional Vite fixture is temporary and owned by that suite. Browser tests do not compile native packages or qualify real native cookies.

On completion, failure, `SIGINT`, or `SIGTERM`, the runner stops only the child process groups and temporary port reservations that it created. It first requests graceful shutdown and then enforces a bounded timeout. It does not stop a process discovered on a port, stop another Compose project, delete database files, or change an external environment.

Stop the disposable example database when finished:

```sh
docker stop "$PAMOFI_VERIFY_CONTAINER"
```

Because that example container was created with `--rm` and no named or host-mounted database volume, stopping it removes that disposable container and its anonymous data volume. Do not adapt this cleanup command to a persistent application database.

## Disposable container labs

These scripts require Docker and Compose. Each owns its uniquely named containers, networks, or volumes and cleans up only those resources. Run them from the repository root after the project builds:

```sh
bash pamofi-backend/pamofi-radius/lab/run-lab.sh
bash pamofi-backend/infra/backup-lab/run-lab.sh
bash pamofi-backend/infra/oracle-staging/test-local.sh
node pamofi-backend/infra/production/run-lab.mjs
node pamofi-backend/infra/production/run-vercel-lab.mjs
node pamofi-backend/infra/radius-production/run-lab.mjs
```

The RADIUS lab sends actual RADIUS packets through FreeRADIUS with two simulated NASes. The backup lab performs an encrypted physical backup and WAL-based restore inside a disposable local setup. The staging lab builds the service images, applies migrations, checks private service readiness, and verifies that the catalogue is unpublished, demo checkout is disabled, and a runtime role cannot connect to another service's database.

The split-host production lab adds the actual Vercel proxy module in an owned local HTTPS fixture, the authenticated Oracle gateway and the production services. The fixture supplies the platform client-IP header, while separate TLS hostnames and a trusted disposable CA preserve hostname/certificate verification. It exercises customer and staff cookies, exact browser Origin, agent cash issuance, receipt redemption, queued allowance and the private usage response. It also checks direct-gateway bypass, forged forwarding headers, internal routes, client-specific rate limits and both monitoring origins. Automatic display after an accounting update is covered by the separate strict browser journey. These checks validate the implementation and production configuration together; Vercel's actual routing, packaging and platform header behavior must still be checked on the identified deployment.

The production RADIUS transport lab uses the production FreeRADIUS configuration and real RADIUS packets with a controlled mutual-TLS authority. It checks transport authorization, rejection and outage behavior. Its controlled authority is separate from the earlier complete ledger/RADIUS lab; neither is a physical MikroTik counter/enforcement test.

## Hosting and site configuration checks

Run these from the repository root. The JavaScript checks create only owned temporary fixtures; they do not contact or configure a router:

```sh
npm --prefix pamofi-frontend/web run test:proxy
node --test pamofi-backend/infra/production/vercel-config.test.mjs \
  pamofi-backend/infra/production/router-control-config.test.mjs \
  pamofi-backend/infra/site-link/*.test.mjs \
  pamofi-backend/infra/radius-production/*.test.mjs \
  pamofi-backend/infra/operations/check.test.mjs
sh pamofi-backend/infra/site-link/check-nft.sh
```

The last command requires Linux, `nft`, `unshare` and permission to create a disposable network namespace. It validates the generated firewall with `nft --check` inside that namespace; it never installs rules into the host firewall. CI installs the required packages on its disposable runner. If a local sandbox disallows sockets, namespaces or child-process test execution, use an approved local execution context or the full CI gate and record the restriction. A skipped, file-only or unavailable check is not a passing execution of its underlying cases.

## Continuous integration

`.github/workflows/verify.yml` runs on pull requests and pushes to `main`, with a manual trigger for repeatable verification. It uses an ephemeral PostgreSQL 17.11 service, the five isolated databases, locked independent installations, Chromium, the strict integration/browser runner, and the container/production infrastructure gates in sequence. The workflow has read-only repository permissions and no deployment step or live provider credentials.

The separate `.github/workflows/mobile.yml` builds an API-unconfigured Android debug APK and an unsigned iOS simulator app, records source hashes and uploads short-lived artifacts without signing credentials. Its actual workflow result is separate from browser acceptance. The production role proof and container labs do not activate a deployment. The completed direct-remote/provider-selection checkpoint at head `147fd7f25eaeb9e124e6e81e89e87cac8bfe2861` passed [Verify run 41382739605](https://github.com/DruHustle/pamofi/actions/runs/41382739605) and [native run 41382739635](https://github.com/DruHustle/pamofi/actions/runs/41382739635), using merge source `bd4ef83322f1e86cc373207e468a184dc59c2e20`. It recorded 168 application/browser cases, all seven builds, 21 infrastructure cases, 141 role checks, 55 production HTTPS checks and the actual RADIUS/backup/staging/production labs. This precedes the Vercel/Oracle/Starlink additions. Consult the pull request and Actions for the exact-source results of those added gates; historical runs do not qualify subsequent code.

## Live acceptance and evidence

Running-service acceptance uses real disposable databases, HTTP service processes and browser sessions. It is stronger than isolated UI mocks, but its synthetic NAS/payment fixtures cannot establish a working physical hotspot or merchant account. Record each boundary separately:

| Boundary | Required evidence |
| --- | --- |
| Agent cash and usage | Approved test agent, allocated inventory, exact cash attestation, private receipt, one redemption and automatically updated remaining usage through the owned accounting fixture. Actual cash handling and physical NAS counters require a separate site acceptance. |
| Direct router management | Observed public IPv4/upstream UDP forwarding or global IPv6 route; recent WireGuard handshake from a genuinely separate network; only the dedicated router management address/ports reachable; other router services and LAN forwarding denied; local management and reboot recovery preserved. |
| Hub fallback | The same router restrictions plus selected host forwarding rules, exact tailnet `/32` route approval, verified owner identity and a real non-owner denial test. |
| Vercel and Oracle deployment | Identified project and VM, exact frontend/API domains, trusted certificate chain, protected proxy token, deployed API routes, secure customer/staff cookie lifecycle, exact Origin enforcement, per-client rate limits, denied direct/internal routes and split-origin monitoring. |
| Starlink site service link | Inspected address spaces, reviewed private `/32` peers and credentials, outbound MikroTik handshake to Oracle, exact RADIUS/HTTPS firewall scope, production NAS registration, trusted HTTPS HotSpot login using the supported PAP/User-Password contract, session/Message-Authenticator attributes, real accounting/enforcement and recovery after uplink/router restart. Keep customer internet on Starlink; unsupported CHAP/MSCHAP/EAP and alternate login bypasses must not grant access. |
| Bank/provider payment | Provider-approved merchant identity, actual sandbox credentials, verified amount/currency/order/merchant and final sale/capture; duplicate/missed callback and reconciliation recovery; reversal/refund cases. Run through the actual pre-login hotspot and phone return flow before enabling real checkout. |
| Native application | Signed/configured device build, approved API origin and real iOS/Android cookie, CSRF, captive-browser and recovery acceptance. A simulator compile does not satisfy these checks. |

The earlier connected-browser block was subsequently cleared. Authenticated read-only WebFig inspection confirmed the private DHCP uplink and no global IPv6/default IPv6 route. The terminal was unresponsive and Resources repeatedly displayed 100% CPU; the cause is unconfirmed. No settings or router restart were performed. The owner then explicitly deferred physical hotspot work until software completion. Keep the current source/configuration and the recorded inspection separate from a live WireGuard, Hotspot or RADIUS acceptance result. The current payment runtime exposes no real bank/provider methods, so local provider-boundary tests must continue to assert unavailable capabilities and zero external calls.

Passing CI is evidence for the recorded source revision and synthetic environments. Staff/MFA, agent/customer commerce, secure receipt delivery and network reconciliation are implemented and covered by those tests. Direct provider/bank payment acceptance and Sendai delivery acceptance, physical RouterOS enforcement, native cookie/device behavior, remote backup recovery and production operations still require external qualification. See [BUILD_STATUS.md](BUILD_STATUS.md) for the current boundary.
