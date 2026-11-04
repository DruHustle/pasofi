# Production source configuration and database privileges

This directory provides a production configuration foundation. It does not deploy anything, invent a public hostname, issue a TLS certificate, enable live payments/SMS/RADIUS, or establish an off-site backup. The network, provider and recovery qualification records remain deployment prerequisites. The base starts all live-provider and customer-network switches disabled; commerce is an explicit operator choice. The public and private TLS gateway contracts are documented in [gateway/README.md](gateway/README.md).

For a **Vercel frontend with an Oracle backend**, use the explicit [Vercel/Oracle overlay and qualification guide](VERCEL_ORACLE.md). That overlay separates the browser origin from the Oracle TLS hostname and authenticates the server proxy. The base below retains its existing single-origin behavior; do not apply its same-host origin assumptions to a split deployment.

The [optional private RouterOS overlay](ROUTER_CONTROL.md) supplies the existing reconciler's protected JSON/CA mounts and controlled activation input. The base and RADIUS defaults remain disabled; device credentials, tunnel/certificate qualification and physical activation are separate deployment inputs.

## Independent database roles

Each of the five databases has three distinct roles. The database names remain `pamofi_identity`, `pamofi_prepaid_access`, `pamofi_network`, `pamofi_notification`, and `pamofi_assistant`.

| Role suffix | Login | Privileges and purpose |
| --- | --- | --- |
| `_owner` | No | Owns only that service's database, schema and migrated objects. |
| `_migrate` | Yes, `NOINHERIT` | Connects only to its own database and may explicitly `SET ROLE` to its owner. Used only for an acknowledged migration/bootstrap operation. |
| `_runtime` | Yes, `NOINHERIT` | Connects only to its own database; receives the reviewed table privileges required by that service. No role membership, DDL, temporary tables, schema creation, truncation or grant option. |

All application roles are `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`. The dedicated PostgreSQL bootstrap login is not an application identity and is never mounted into a runtime container. Public database connection and public schema privileges are revoked. `init.sh` also revokes public access to the dedicated cluster's maintenance/template databases; it is for a new dedicated cluster, not a shared PostgreSQL installation.

`roles.sql` sets **global default privileges for the non-login owner**. Future tables, sequences, types, schemas and routines grant nothing to runtime or `PUBLIC`. In particular, PostgreSQL gives public function execution by default, and a per-schema revoke cannot remove a global default: this configuration uses a global revoke. See the [PostgreSQL default-privilege rules](https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html) and [role membership options](https://www.postgresql.org/docs/17/sql-grant.html).

Migrations connect as the migration login with `PGOPTIONS=-c role=<owned role> -c search_path=public`, so newly created objects inherit the **owner's** default privileges. After the service's unchanged, independent `migrate.mjs` finishes, `apply-grants.mjs` applies the version-controlled [role-policies.json](role-policies.json) manifest. An unexpected or missing table, or an unreviewed new sequence, fails that release step. New objects cannot silently become writable by a service. Runtime has read-only access to migration history and no access to the permanent staff bootstrap guard. Audit and allocation histories receive only `SELECT`/`INSERT`. Demo payment/SMS fixtures and legacy demo inventory receive no production runtime privileges. Only the account-hold table needs runtime `DELETE`.

Customer-creation retry records, agent-sale records and the NAS registry take row locks. PostgreSQL requires an update privilege for those locks, so these tables receive a narrowly scoped update privilege on their key column. No other historical or NAS configuration columns become writable through those grants. The network runtime can read and lock registered NASes, but cannot register a new NAS or change its enabled state, site, client name or login URL; those operations belong to the migration/owner procedure. Existing column grants are explicitly removed before reapplying policy; table-level revocation alone would leave them in place. Trigger routines do not receive direct public or runtime execute grants. The owner installs the triggers, which continue to run during permitted runtime writes.

## Secret files and non-root readers

Create a new secret set outside the checkout:

```bash
node pasofi-backend/infra/production/generate-secrets.mjs \
  --directory /absolute/protected/pamofi-secrets --new-install-only
```

The tool refuses an existing directory, a repository location or reuse of a previous installation. It generates independent random database passwords, runtime and migration DSNs, internal service keys, the staff MFA encryption key, a voucher key ring (`initial`) and a RADIUS credential key ring (version `1`). It prints no credential values. Retain the generated files if a later external certificate step is incomplete; never regenerate over a live installation.

The host parent is `0700`. Each application secret file is explicitly `0444` and is mounted **individually**, because Compose file-backed secrets can preserve host ownership and ignore requested UID/GID mappings. Other host users cannot traverse the private parent; container UID `1000` (`node`) and PostgreSQL's distinct UID can read only the specific files mounted into their container. The secret directory itself is never mounted. Check the actual resulting file modes and container readability on the deployment host. The one-time staff password file is different: it must remain `0600`/`0400` and the bootstrap process runs as its owner, as described below.

Supply qualified certificate files separately in that same protected directory:

| File | Required use |
| --- | --- |
| `public_tls_cert`, `public_tls_key` | Valid public certificate/key for the chosen public hostname. |
| `internal_ca` | CA used by Node to verify the private gateway. |
| `internal_tls_cert`, `internal_tls_key` | Server certificate/key with the configured `identity.internal`, `prepaid.internal`, `network.internal` and `notification.internal` SANs. |

Never disable TLS verification to work around an untrusted certificate. The private gateway accepts only the reviewed internal paths; each service still verifies the narrowly scoped JWT. Application secret values are read by `entrypoint.mjs` before the owning service starts and do not appear in Compose environment values or command arguments. Runtime containers receive only their runtime DSN. The migration profile receives only its migration DSN. The entrypoint rejects a DSN whose login or database does not match that service and operation, or whose query string could override connection settings.

## Preparing a release

Set these non-secret Compose inputs through the operator's deployment configuration:

- `PAMOFI_PUBLIC_HOST`: qualified public hostname, matching the public certificate and customer origin.
- `PAMOFI_SECRETS_DIR`: absolute path to the protected secret directory.
- `PAMOFI_DATABASE_VOLUME`: the name of an operator-created, persistent external Docker volume for this installation. Choose a distinct name for each environment and retain it across releases.
- `PAMOFI_SERVICES_SUBNET`: an explicitly chosen, non-overlapping private IPv4 subnet for service/proxy traffic. There is no guessed live-network value. Identity and prepaid trust forwarded client addresses only from this configured CIDR; the sole public ingress overwrites incoming forwarding headers.
- `PAMOFI_IDENTITY_IMAGE`, `PAMOFI_PREPAID_IMAGE`, `PAMOFI_NETWORK_IMAGE`, `PAMOFI_NOTIFICATION_IMAGE`, `PAMOFI_ASSISTANT_IMAGE`, `PAMOFI_WEB_IMAGE`: independently built, verified release images, preferably immutable registry digests. Images must contain their own built outputs and locked production dependencies; no service imports another service's source.
- `PAMOFI_COMMERCE_ENABLED`: reviewed `true`/`false` choice, and `PAMOFI_AGENT_COMMISSION_BPS`: the intended commission in basis points, not an assumed business policy.
- `VOUCHER_DELIVERY_ACTIVE_KEY_ID`: `initial` for the first generated key ring; `RADIUS_CREDENTIAL_KEY_VERSION`: `1` for the first generated ring. Preserve old keys for stored ciphertext and coordinate any later key rotation.

Create the database volume once, after checking the intended host and environment. The example name is an operator choice, not a reference to an existing installation:

```bash
export PAMOFI_DATABASE_VOLUME=pamofi-production-database
docker volume create --label pamofi.purpose=production-database "$PAMOFI_DATABASE_VOLUME"
docker volume inspect "$PAMOFI_DATABASE_VOLUME"
```

The PostgreSQL startup wrapper copies the reviewed initialization script from its read-only mount into the container filesystem before invoking the official image entrypoint. The official entrypoint still runs initialization only on an empty cluster; existing clusters are not reinitialized. This avoids attempting to execute a no-execute bind mount.

The PostgreSQL health check requires the five service databases, their expected owner and login roles, migration membership and database connection grants. It therefore rejects an incomplete first initialization even if PostgreSQL has restarted and is accepting connections. This read-only check does not prove passwords, migrations, schema grants or backup integrity. A database that fails it needs operator investigation; do not initialize a replacement volume as a shortcut. The check uses the local PostgreSQL socket as the bootstrap user as well as a TCP readiness probe. Run `bash pasofi-backend/infra/production/test-postgres-readiness.sh` against a local Docker daemon to exercise incomplete and existing-style installations.

The Compose volume is declared `external: true`. Compose refuses to start if the named volume is missing and does not remove it during `docker compose down --volumes`. This protects against an ordinary application teardown; an explicit Docker volume removal or host loss still requires independent backups. Never change the volume name to work around an initialization or migration failure: that would start a different database.

Before starting PostgreSQL, run the read-only volume preflight from the repository root. It requires an explicit installation mode, never creates or modifies the volume, and rejects a root-level PostgreSQL cluster because this stack expects `pgdata/`:

```bash
export PAMOFI_INSTALL_MODE=new  # Use only for a verified empty new installation.
bash 'pasofi-backend/local-tools/manual deployment/preflight-production-volume.sh'
```

For an upgrade, set `PAMOFI_INSTALL_MODE=upgrade` and `PAMOFI_EXPECTED_SYSTEM_ID` to the independently recorded PostgreSQL system identifier from the existing production release. The check requires PostgreSQL 17 and a matching `pgdata/` cluster. It does not replace a verified backup, restore test, migration review or exclusive deployment control. In particular, the historical private staging volume uses a root-level data directory; do not point this production stack at it without a separately reviewed migration.

Validate configuration, start the private database, apply every owned migration/grant policy, and only then start runtime services:

```bash
cd pasofi-backend/infra/production
docker compose config --quiet
docker compose up -d --wait postgres
for service in identity prepaid-access network notification assistant; do
  docker compose --profile migrate run --rm "$service-migrate"
done
docker compose up -d --wait --wait-timeout 120
```

The base publishes only the public gateway's `80` redirect and `443` TLS listener. PostgreSQL and all APIs have no host ports. The `database` and `services` networks are internal; the private gateway has no published port. Frontend assets and the reviewed API allowlist are served by the private `web` image. This base deliberately has no provider/router egress path; enabling those capabilities requires a reviewed overlay with qualified credentials, network routes and explicit feature gates. The backup overlay under `../backup-production` provides its own separate repository egress, PGDATA convention and independent credentials.

## First administrator

Apply identity migrations first. Create `first_staff_password` in the protected secret directory with mode `0600` or `0400`, owned by the operator who will run bootstrap. Do not pass its contents as an argument or commit it. Set the non-secret first-operator details (`STAFF_BOOTSTRAP_EMAIL`, `STAFF_BOOTSTRAP_DISPLAY_NAME`, `STAFF_BOOTSTRAP_REASON`) and `STAFF_BOOTSTRAP_CONFIRM=first-admin`. Set `PAMOFI_BOOTSTRAP_UID` and `PAMOFI_BOOTSTRAP_GID` to that password file's actual numeric owner and group. The one-time overlay runs the process with that identity so a Linux bind-mounted private file is readable without making it public:

```bash
docker compose -f compose.yaml -f bootstrap-staff.compose.yaml \
  --profile bootstrap run --rm identity-bootstrap
```

Bootstrap is serialized, audited and permanently one-time. It does not issue a session or bypass MFA: the operator must sign in and enroll an authenticator. Remove the one-use password file after verifying the saved credential and authenticator. Keep at least two separately authenticated, approved administrators and retain the environment's MFA encryption key in the independently protected recovery procedure. See the identity service README for the full contract and current MFA-key rotation limitations.

## Local and CI privilege qualification

The role proof uses a dedicated **loopback** test cluster with bootstrap privileges. It creates randomly prefixed databases/roles, runs all five actual migrations and grant manifests, checks the complete 5×4 cross-service connection-denial matrix, and cleans only its own resources. It verifies denied DDL, schema/temp creation, role escalation, migration-history writes, audit rewriting, truncation, ungranted future tables/functions/sequences, and allowed explicit DML. It also starts the real identity service under its production runtime role and exercises customer creation/retry and staff password/MFA enrollment. For the network runtime it denies NAS registration, deletion and configuration changes, proves both required row-lock modes work, and executes actual credential issuance plus its locked idempotent retry.

```bash
PAMOFI_TEST_CONFIRM_ISOLATED=1 \
PAMOFI_TEST_BOOTSTRAP_DATABASE_URL='postgresql://<test-bootstrap>:<test-password>@127.0.0.1:<test-port>/postgres' \
node pasofi-backend/infra/production/test-roles.mjs
```

Run from the repository root after independently building the services. `psql` must be on PATH, or set `PSQL_BIN` to its absolute executable. This proof does not connect to a public database or alter the existing five demo databases. It does not claim to validate an off-site backup, public TLS issuance, live provider delivery, actual router termination or production capacity. Those have separate qualification procedures.

## Disposable production Compose and TLS lab

After building the five services and web project, run on a Linux host with a local Docker daemon, Docker Compose, Node 24 and OpenSSL:

```bash
node pasofi-backend/infra/production/run-lab.mjs
```

No environment credentials are needed. The lab creates a unique Compose project, local image tags, an unused Docker service subnet, ephemeral loopback gateway ports, temporary secret files and a one-day test CA. It renders the actual base, first-administrator and backup overlays, retaining the migration/bootstrap profiles. It starts the base configuration, applies all current service migrations and production runtime grants, and performs the real one-time administrator bootstrap.

The executable checks verify HTTPS certificate trust, public route boundaries, secure customer cookies and one-time handoff, real administrator TOTP enrollment, private JWT-scoped identity and notification requests, and rejection of forged proxy chains. Each non-root runtime must read its own file secrets and have no mounted migration or bootstrap password. Container inspection proves only the public gateway binds host ports, both on loopback. The read-only operations checker exercises anonymous HTTPS checks and aggregate queries under the three owning runtime roles. Finally, the lab runs an explicit `down --volumes`, confirms the external volume survives, restarts PostgreSQL and verifies the permanent bootstrap record is still present.

The production backup image also runs its normal entrypoint with networking disabled and synthetic individually mounted credentials. That check verifies the generated configuration is mode `0600`, owned and readable by PostgreSQL, uses the required database path, encryption and TLS verification, and contains the pinned pgBackRest binary. No B2 request is made and no real backup is claimed by this lab.

The lab also starts the **actual private RADIUS authority** from the production overlay, using the genuine non-root network image, startup wrapper, runtime database role and individually mounted disposable TLS/service secrets. A separate non-root probe on the internal transport network verifies mutual TLS and exact `401` rejection for an unregistered NAS on both routes; a registry/database failure would produce `503`. Missing-client and wrong-CA requests fail, and the actual wrapper refuses an unqualified startup. The test creates no NAS registration, credential or access grant and starts no UDP server. Main-service network/RADIUS/reconciler gates remain false. The authority is explicitly stopped and removed before the volume recovery proof; real packet/ledger acceptance remains covered by the separate RADIUS labs.

Cleanup stops only the generated project and labeled test container, then removes only its labeled test volume, own image tags and temporary files. GitHub CI runs the executable; a syntax or configuration-render check alone is not evidence that its Docker/TLS assertions passed.
