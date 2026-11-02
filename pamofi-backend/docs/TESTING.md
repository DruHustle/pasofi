# Testing PamoFi

The repository has seven independent Node projects: five backend services, the web interface, and the mobile application. Run the repository verification tool from any directory; it resolves all project paths relative to its own file. It never imports application code across project boundaries.

## Choose the verification level

| Command or check | What it verifies | What it does not establish |
| --- | --- | --- |
| `node pamofi-backend/local-tools/verify.mjs --install` | Installs each project's locked dependencies; builds all seven projects; runs service tests without test databases | Database-dependent cases are explicitly reported as skipped; no browser or integration acceptance |
| `node pamofi-backend/local-tools/verify.mjs --integration` | Runs each service's migrations; starts five owned loopback demo processes; runs all service tests against dedicated PostgreSQL databases, including authenticated cross-service calls and the TLS RADIUS adapter | No browser, physical router, live provider, or Docker backup acceptance |
| `node pamofi-backend/local-tools/verify.mjs --integration --browser` | Adds real customer/staff/agent web journeys plus web/mobile fault mocks and offline checks against owned Vite/API processes | No real payment, SMS, hotspot, native phone build, or production acceptance |
| The three container labs below | Actual FreeRADIUS packets, disposable encrypted backup/restore, and private staging configuration | No qualification of a physical router, commercial provider account, or off-site backup destination |

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

The runner assigns temporary loopback ports, sets the matching frontend proxies and identity origin, and checks the readiness of the processes it started. It strips inherited provider credentials and service configuration, explicitly disables Pesepay sandbox calls and the background outbox dispatcher, and uses synthetic service keys. Provider tests use local fakes; they do not initiate actual payments or send SMS. The RADIUS adapter tests use temporary TLS certificates and simulated NAS contexts.

Web and mobile browser results are written to each project's ignored `test-results/verification-summary.json`; Playwright also keeps failure traces or screenshots requested by the suites there. The terminal prints per-project results and the final number of passing tests. The web suite includes an actual three-context MFA/approval/allocation/sale/private-receipt/redemption journey. Guarded service-owned fixture CLIs receive isolated database settings only in the test process; test code does not import backend implementation. The mobile suite covers two offline layouts and five configured HTTPS API mocks, including cookie refusal, capability gating and refusal to discard a quote with an existing provider attempt. Its additional Vite fixture is temporary and owned by that suite. Browser tests do not compile native packages or qualify real native cookies.

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
```

The RADIUS lab sends actual RADIUS packets through FreeRADIUS with two simulated NASes. The backup lab performs an encrypted physical backup and WAL-based restore inside a disposable local setup. The staging lab builds the service images, applies migrations, checks private service readiness, and verifies that the catalogue is unpublished, demo checkout is disabled, and a runtime role cannot connect to another service's database.

## Continuous integration

`.github/workflows/verify.yml` runs on pull requests and pushes to `main`, with a manual trigger for repeatable verification. It uses an ephemeral PostgreSQL 17.11 service, the five isolated databases, locked independent installations, Chromium, the strict integration/browser runner, and the three container labs in sequence. The workflow has read-only repository permissions and no deployment step or live provider credentials.

The separate `.github/workflows/mobile.yml` builds an API-unconfigured Android debug APK and an unsigned iOS simulator app, records source hashes and uploads short-lived artifacts without signing credentials. Its actual workflow result is separate from browser acceptance. The production role proof and production container lab also have their own documented commands under `infra/production`; they do not activate a deployment.

Passing CI is evidence for the recorded source revision and synthetic environments. Staff/MFA, agent/customer commerce, secure receipt delivery and network reconciliation are implemented and covered by those tests. Actual Pesepay/Sendai acceptance, physical RouterOS enforcement, native cookie/device behavior, remote backup recovery and production operations still require external qualification. See [BUILD_STATUS.md](BUILD_STATUS.md) for the current boundary.
