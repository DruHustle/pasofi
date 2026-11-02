# Disposable backup and restore laboratory

This is a **local test**, not a production backup service. It creates a uniquely named PostgreSQL 17 cluster and an AES-256-CBC pgBackRest repository in disposable Docker volumes. It applies the service migrations from this checkout with their checksum ledger, inserts synthetic fixtures, creates a full backup, writes another transaction after the backup, archives WAL, stops the source container, and restores to a separate volume. The restored server has no network and is never joined to application services.

The drill checks that an incorrect repository key cannot read its metadata, the post-backup transaction was recovered from WAL, the customer, session retry record and all five service databases exist, the ledger, uncertain grant and pending outbox event remain consistent, a second live grant is rejected, and a service role cannot connect to another service's database. Stopping the disposable source simulates fencing; it does not verify that an Oracle VM or router is externally fenced. It does not test real customers, providers, live delivery, off-server storage, continuous operations, or an application login.

From `pamofi-backend`, run:

```sh
./infra/backup-lab/run-lab.sh
```

Docker, OpenSSL, Bash and enough disk space are required. The build downloads the pinned base image and Alpine pgBackRest package; the test containers themselves use `--network none` and publish no ports. The script uses a new random encryption key on each run and removes only the containers and volumes it created when it exits. A force-killed process or Docker failure can leave resources named `pamofi-backup-lab-<random id>-...`; inspect those specific resources before manually removing them. The reusable local image `pamofi-backup-lab:2.57.0` remains after the test.

A production implementation still needs independently protected encryption keys, an encrypted off-server repository such as an operator-configured B2 bucket, continuous WAL archiving, scheduled backups, retention and monitoring, application-level reconciliation and external fencing. The local lab is evidence about the restore procedure, not evidence that production backups exist or meet recovery targets.
