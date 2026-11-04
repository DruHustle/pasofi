# Independent encrypted PostgreSQL recovery

This optional production overlay adds pgBackRest and continuous WAL archiving to the existing private PostgreSQL container. The repository is a **separate Backblaze B2 bucket**. It protects the complete cluster, including all five databases, role definitions, migration ledgers, balances, reservations and outbox records. It is not enabled by a source change or by the local backup lab.

## Configure and qualify

Create a private B2 bucket in an account administered independently of the application host. Create a bucket-scoped application key with the listing, reading, writing and deletion capabilities required by pgBackRest retention. Keep a separately protected recovery copy of that key and the encryption passphrase. The host needs a working key to archive WAL; independent recovery therefore also needs an off-host copy. Use B2 controls and a separate credential to protect against an attacker deleting all recovery copies; do not add an untested object-lock policy to the same mutable pgBackRest prefix.

Supply the production stack's existing `PAMOFI_SECRETS_DIR` and add private files `b2_key_id`, `b2_application_key`, `backup_cipher` (a random passphrase of at least 32 permitted characters). Supply `B2_BUCKET`, `B2_REGION`, and a unique `BACKUP_REPOSITORY_PREFIX`, such as `/pamofi-production`. No secret belongs in Compose, Git, command arguments or shell history. The image creates its secret-containing pgBackRest configuration in tmpfs with mode 0600; only the PostgreSQL user can read it.

From `infra/production`, render both Compose files before applying the change:

```sh
docker compose -f compose.yaml -f ../backup-production/compose.yaml config --quiet
docker compose -f compose.yaml -f ../backup-production/compose.yaml build postgres
```

Use a maintenance window to activate the overlay on the existing database volume; `archive_mode` requires a PostgreSQL restart. Keep `PGDATA` identical to the original stack. Never let a changed path initialize an empty replacement cluster. After restart, run `../backup-production/backup.sh stanza-create`, `backup.sh full`, and `backup.sh check`. Verify `archive_mode`, `archive_command`, `pg_stat_archiver`, and a recent backup from `backup.sh info`. A successful configuration check is not evidence of a working B2 backup.

Schedule a full backup weekly, differential backups daily, `check` hourly, and an isolated restore drill monthly using the host's job runner. The supplied commands return nonzero on failure so the host can alert. The defaults retain four full backups and fourteen differentials, while pgBackRest retains required WAL; capacity must include a new full backup before expiration. Keep the encryption passphrase unchanged for an existing repository; move to a new independently validated repository for an encryption-key change.

## Restore and fence

1. Confirm the backup set, required WAL, encryption key and compatible PostgreSQL major version on a **new isolated host/volume**. Do not restore over a running cluster.
2. Fence the old authority: stop its prepaid/network workers, remove its ability to authorize RADIUS, stop PostgreSQL and revoke its service/tunnel access. Verify the fence from the network side. Do not permit two authorities to issue reservations.
3. Restore with the same pgBackRest configuration, a read-only repository credential if available, and `pgbackrest --stanza=pamofi restore`. For point-in-time recovery, choose and record a verified recovery target. Start the restored database with `archive_mode=off` until the recovery is inspected and a new writable archive timeline is established.
4. Verify all five database/role boundaries, migration checksums, order/payment/provider identities, voucher uniqueness, encrypted delivery key versions, global live-grant uniqueness, accounting balances and outbox/inbox deduplication.
5. Treat all pre-restore active reservations as uncertain. Revoke outstanding network credentials, disconnect their NAS sessions and reconcile final usage before allowing another site to grant access. Verify providers by their existing references; do not reinitiate charges or blindly resend ambiguous SMS attempts.
6. Rotate compromised service sessions/credentials separately, restore the approved gateway/tunnels, run the source and hardware acceptance checks, and resume one authority only. Record actual data-loss and restore-time measurements.

The CI lab already exercises encrypted full backup, wrong-key rejection, WAL after the full backup, restore into a separate volume, five-database isolation and old-server fencing. It uses no B2 account. B2 connectivity, independent key custody, scheduling and an actual off-host restore remain deployment acceptance steps.

References: [pgBackRest configuration](https://pgbackrest.org/configuration.html), [pgBackRest user guide](https://pgbackrest.org/user-guide.html), and [Backblaze S3-compatible API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api).
