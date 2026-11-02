# Operations, release and rollback

These tools operate only on a deliberately configured PamoFi environment. No host, scheduler, alert destination or production deployment is selected by checking them in. Keep the [production role/secret instructions](../production/README.md), [independent backup procedure](../backup-production/README.md) and actual site acceptance record with the release record.

## Read-only checks

Run the diagnostic on the deployment host with the production stack's non-secret environment and protected secret-file paths already configured:

```sh
node pamofi-backend/infra/operations/check.mjs --queues --with-backups
```

It requires Docker Compose and Node, uses the declared production project, and checks:

- All nine expected services exist exactly once and run; the database, five APIs and web container are healthy.
- Only the gateway publishes TCP ports for HTTP/HTTPS. A published database or private API is an error.
- The public HTTPS gateway has a trusted certificate, returns liveness, rejects anonymous customer-session reads without creating a session, and refuses internal paths. Redirects are not followed. It uses `https://${PAMOFI_PUBLIC_HOST}`, or an explicit `PAMOFI_MONITOR_ORIGIN` HTTPS origin for a qualified alternate port.
- With `--queues`, fixed aggregate queries execute as each owning service's runtime database role, inside a read-only transaction with a three-second statement timeout. They report dead/delayed outbox items, payment review/dead verification jobs, account holds/uncertain or stale grants, ambiguous/failed/delayed SMS, and unavailable/unconfirmed router observations. No customer identifiers, vouchers, phone numbers, credentials or provider payloads are returned.
- With `--with-backups`, pgBackRest's repository status and most recent successfully completed backup are checked. The default maximum age is 30 hours for a daily differential schedule; set an explicitly reviewed `PAMOFI_BACKUP_MAX_AGE_HOURS` between 1 and 168 if the operating schedule differs. Missing, failed, stale and future-dated evidence fails closed.

The JSON result is suitable for a host job runner. A nonzero exit means an operator should investigate. The tool never restarts a service, changes balances, retries a payment, resends a message, replays outbox records, sends a notification or modifies router access. Missing optional flags are reported as `not_checked`, not a successful qualification of that subsystem. A known unresolved review remains visible on later runs until the owning workflow resolves it.

The disposable production lab supplies an absolute `PAMOFI_OPERATIONS_COMPOSE_FILE` containing its rendered complete configuration and an explicit `PAMOFI_OPERATIONS_PROJECT` to scope the check to its own containers. These overrides can also inspect an operator-reviewed alternative release configuration. When providing a complete file with `--with-backups`, that file must already include the qualified backup overlay. The tool does not merge an unrelated live project into the lab.

Run a health/queue check every minute and a backup check hourly using the organization's existing scheduler, with explicit alert routing to the responsible operator. First verify that a deliberate test failure reaches that operator. Do not call a checked-in script an active monitor until a real scheduled run and alert receipt have been recorded. A host-local checker cannot detect a completely unavailable host: add a separate external HTTPS check and independently monitor the backup repository. This source change sends no messages and creates no schedules.

The read-only backup check verifies completion age, not continuous WAL delivery. Separately schedule `backup.sh check`, inspect `pg_stat_archiver` failures and accumulated WAL/disk space, and periodically perform the isolated off-host restore. That command may force a WAL switch and is deliberately not hidden inside this read-only diagnostic. A reachable repository and a recent backup do not establish the recovery time or retained encryption-key custody.

## Selected Vercel/Oracle and site deployment

For the split-host deployment, keep `PAMOFI_MONITOR_ORIGIN` as the Oracle HTTPS gateway and set `PAMOFI_MONITOR_FRONTEND_ORIGIN` to the exact Vercel production origin. The checker then proves that Oracle denies unauthenticated direct API access while the frontend's anonymous `/api/session` read returns 401 without creating a cookie. Both sides must return the expected JSON boundary responses; a static HTML/SPA fallback is a failure. These read-only probes send no proxy credential and never create an account. The default single-host checks remain available when no separate frontend origin is configured.

After the private production RADIUS profile has been qualified and activated, set `PAMOFI_OPERATIONS_RADIUS_BIND` to the exact private IPv4 WireGuard address on Oracle. The checker then requires the `radius` process and healthy `radius-api` service, and accepts only UDP 1812/1813 bound to that exact address with matching target/published ports. Wildcard, public, wrong-address or extra listeners remain errors; the mTLS `radius-api` must never publish a host port. Without this explicit setting, published RADIUS ports are rejected. This check verifies declared Docker bindings, not the actual host/cloud firewall or a physical NAS.

Use `PAMOFI_OPERATIONS_COMPOSE_FILE` with an absolute rendered configuration path and `PAMOFI_OPERATIONS_PROJECT` when inspecting the stack assembled from deployment overlays. Keep credentials in protected secret files. The checker does not activate profiles, change firewall rules or infer a deployment from the selected hosting providers.

## Respond to a failed check

| Signal | First response |
| --- | --- |
| API/database not ready | Inspect bounded sanitized service logs and resource use; preserve all databases and queued work. Liveness alone does not permit new commerce. |
| Unexpected published port | Restrict the unintended listener through the reviewed deployment configuration; keep local recovery access. Verify from outside the host. |
| Payment unknown/review | Reconcile by the existing provider reference and order terms. Do not initiate another charge to clear the alert. |
| SMS unknown or delayed | Poll a known provider ID. Unknown submission is not permission to resend; an authorized reasoned resend is a separate audited action. |
| Grant hold, stale accounting or unreachable router | Retain the reservation. Restore private management reachability, fence the credential, obtain final accounting and independent absence, then use the versioned administrator review when required. |
| Outbox dead/delayed | Verify recipient service TLS/authentication and inbox status. Preserve event identity and use the authorized replay procedure; never fabricate a replacement event. |
| Backup/WAL failure | Preserve existing recovery copies, check capacity and independent credentials, restore archiving and prove recovery. Do not remove WAL manually to free space. |

Observe host/container memory, CPU, disk and connection usage under the measured workload. The hAP lite has limited RAM; its acceptable customer count is a hardware test result, not a hard-coded promise. Logs must omit secrets and raw provider/router responses. Retain audited operator decisions with access controls and the deployment's agreed retention policy.

## Release procedure

1. Select the exact reviewed source commit and independently built image digests. Record the CI run, migration list/checksums, gateway configuration, feature flags, key versions and applicable provider/router/mobile acceptance evidence. Do not rebuild an unrecorded mutable `latest` image during release.
2. Check the current state, active/uncertain grants, pending payments/SMS and outbox. Record unresolved work. Confirm fresh independent backup/WAL evidence and a tested restore procedure before applying migrations. Keep all required previous encryption-key versions.
3. Review the schema change for compatibility with the previous application version. Prefer additive changes followed by a later cleanup release. Existing applied migration files are immutable. Establish a maintenance window for incompatible migrations or database restarts and let bounded in-flight operations settle.
4. Validate Compose, preserve the explicitly named external database volume, and apply each service's migrations with its migration identity. The reviewed grant manifest must succeed before new runtime images start. No runtime container receives the migration or bootstrap password.
5. Start the selected images, wait for readiness, then run the HTTPS/queue check. Check same-origin sessions, staff MFA, scoped agent stock and a deliberately chosen acceptance transaction in the appropriate environment. Production payment or SMS acceptance requires the configured merchant/operator procedure and its authorized cost; do not silently substitute a live charge for a mock test.
6. Enable only capabilities with completed acceptance evidence. Verify the public exposure boundary, private TLS, real router accounting/termination, active monitoring and backup schedule. Record the release and operator decision. Keep recovery access available.

## Rollback and disaster recovery

If the schema remains backward-compatible, return each failed application image to the recorded previous digest and restore its compatible configuration/key ring. Re-run readiness and targeted acceptance. Do not run a second writer/authorizer beside the first, erase migration history, or blindly execute reverse SQL against balances or audit records.

If an incompatible migration or data corruption requires database recovery, stop and fence the old authority before opening the restored one. Follow the independent backup restore procedure on a new isolated volume/host. A database rewind can lose legitimate charges and accounting that happened after the recovery point: reconcile provider references and final router usage before serving customers. Treat pre-restore live grants as uncertain, revoke temporary credentials, disconnect physical sessions and preserve ambiguous SMS outcomes. Never deploy an old application binary against a schema it cannot read safely.

Prove rollback and restore in an isolated environment before relying on them operationally. Record the actual recovery point, data reconciliation and restoration duration; source tests do not supply a production RPO/RTO guarantee.

References: [Docker Compose JSON status](https://docs.docker.com/reference/cli/docker/compose/ps/) and [pgBackRest monitoring](https://pgbackrest.org/user-guide.html#monitoring).
