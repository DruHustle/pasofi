# Upgrade an existing PasoFi Oracle installation

This tool upgrades the existing Docker Compose installation from a qualified, pinned source archive. Run preflight first, review its service list, and repeat the same command with `--apply`. It does not install a new database or choose new credentials, ports, domains, delivery providers, or launch gates.

## Prerequisites

- A release bundle containing `release.json`, `source.tar.gz`, `release-deploy.py`, and the launcher for your platform. The Mac package includes `release-deploy.command` and `release-deploy.sh`; a Windows package uses `release-deploy.cmd`. Keep the supplied launcher and Python engine together. Use the bundle prepared after the release checks pass; do not substitute a branch archive or edit its manifest.
- Python **3.9 or newer** on the workstation and Linux server. Windows needs the Python launcher (`py`) or `python` on PATH. Windows, Mac and Linux need OpenSSH (`ssh`, `scp`).
- An existing SSH configuration alias for the server. The normal OpenSSH host-key check remains enabled. The SSH account must already have Docker access and read access to the installation's protected configuration files. No automatic `sudo` is used.
- First run an ordinary interactive `ssh YOUR_SSH_ALIAS`, verify the server fingerprint through your existing trusted record, confirm access, and exit. Load an encrypted key into your SSH agent. The deployment uses `BatchMode=yes` and a 15-second connection timeout: unknown hosts or unavailable keys fail promptly instead of waiting for hidden prompts. It never accepts a host key automatically.
- The exact absolute path of the existing Compose environment file on the server. Repeat `--env-file` in its original order if the installation uses multiple files. No environment file is created or overwritten.
- The independently retained PostgreSQL **system identifier** from the installation/backup record. This identifies the cluster, not a database name or container ID. If that record is missing, independently establish the correct production cluster before deployment; do not copy whatever ID an unfamiliar server happens to return.
- A recent successful protected database backup and enough free disk space for the source, locked dependency installs, new images and old rollback images. Keep the backup and restore evidence with normal operations records.

The script discovers the actual project, working directory and ordered Compose files from existing Docker labels. If more than one PasoFi project exists, add `--project EXISTING_PROJECT`. It retains every overlay, including RADIUS, router control, captive portal, mail and other existing qualified configuration. It stops when labels are missing, paths no longer exist, overlay orders conflict, or the rendered configuration differs from running mounts, environment, networks or ports. Resolve that specific installation mismatch rather than replacing the stack with a base Compose file.

## Windows CMD

Open CMD in the unpacked release folder. Replace the placeholders with your own existing SSH alias, protected server path and recorded database identifier. Do not include angle brackets.

```bat
release-deploy.cmd --host YOUR_SSH_ALIAS --manifest release.json --archive source.tar.gz --env-file /absolute/existing/production.env --expected-database-id YOUR_RECORDED_SYSTEM_ID
```

After preflight succeeds and the displayed plan is correct:

```bat
release-deploy.cmd --host YOUR_SSH_ALIAS --manifest release.json --archive source.tar.gz --env-file /absolute/existing/production.env --expected-database-id YOUR_RECORDED_SYSTEM_ID --apply
```

PowerShell can run the same entry point as `./release-deploy.cmd` with the same arguments. No execution-policy change is required. Quote paths containing spaces. Keep the three entry-point files together.

## Mac or Linux terminal

```sh
bash release-deploy.sh --host YOUR_SSH_ALIAS --manifest release.json --archive source.tar.gz --env-file /absolute/existing/production.env --expected-database-id YOUR_RECORDED_SYSTEM_ID
```

Repeat with `--apply` after reviewing preflight. To run directly on the existing Linux Docker host, omit `--host` and use local paths to the release manifest/archive. Optional `--release-root /absolute/private/directory` is available only in direct-server mode; it must have mode `0700`. The default record directory is the SSH account's `~/.local/share/pasofi-releases`.

Preflight verifies the manifest hash and archive's Git commit, reads the current stack and cluster identity, and checks the proposed Compose merge. It creates temporary staging files but makes **no changes to running containers, images, database contents, secrets or persistent volumes**. No production host is contacted until the operator actually runs the entry point with `--host`.

## What apply does

1. Repeats preflight and creates a private release/rollback record on the server.
2. Extracts the exact qualified source, installs locked dependencies inside the repository's Node builder image, and builds the manifest's selected application images. It builds the web image; when a captive portal is already mounted, it also builds its separate `VITE_PASOFI_HOTSPOT_PORTAL=1` assets and retains that existing mount destination.
3. Rechecks the original Compose/environment files, container identities and database identifier. If the installation changed during the build, it stops before migration.
4. Runs only the matching owned migration services with the new image and updated entrypoint, grant script and role policies. The invoice release includes prepaid migration `030` and notification migration `005`; the services' normal migration ledger determines what is pending.
5. Updates the selected `network` service first, then `prepaid-access`, then the remaining selected applications, web and the two gateways. Each phase uses `--no-deps --no-build --pull never` and the existing 180-second Compose health wait. Before a downstream phase starts, the updated dependency must run its exact built image, be healthy, and pass fixed local live/service-identity and readiness HTTP checks. A failure stops the remaining phases. The existing gateway image IDs are retained while their reviewed configuration binds move to the pinned source.
6. After every phase, rechecks the updated image identities, health, database identity and protected Postgres/RADIUS container IDs, images, mounts and host settings. Completion is recorded only after all phases pass.

Custom manifests selecting `prepaid-access` must also select `network`; manifests selecting `web` must include both. The manifest carries no compatibility evidence for an omitted dependency, so a healthy older container cannot satisfy that requirement. The full automatic package already selects these services and their owned migrations. Preflight displays the phase order before application changes.

The updated hotspot clients require the backend's explicit access-point and site/NAS response fields. This coordinator updates the Compose web/captive target. Vercel and mobile releases remain separate: activate them only after the network and prepaid backend release is verified. Keep the existing launch and payment gates unchanged during the rollout.

It never calls `down`, removes orphans, prunes images, recreates Postgres/RADIUS, modifies existing secret/environment files or changes feature gates. The new network image is scoped to `network` and `network-migrate`; the existing RADIUS authority keeps its exact image and mounts. Optional `invoice-delivery.compose.yaml` and `invoice-sms.compose.yaml` are **not added automatically**. Issuing an invoice and enabling a qualified external email/SMS provider are separate operations. Existing provider settings are retained; a previously disabled channel stays disabled.

The command stopping is not proof that nothing changed: builds, completed migrations, or some application replacements can remain after a later failure. Read its last safe progress message and the private record before retrying. Database migrations are additive and tracked, so a retry follows the existing migration ledger. Apply holds an exclusive project lock in the original Compose working directory; the SSH account must be able to create that private lock file. A second invocation stops while the first holds it. Success also requires every selected runtime image to match its newly built image ID. Do not run a separate manual deployment at the same time.

## Rollback and evidence

The command prints the private `record.json` location. The directory contains the manifest, planned runtime phases, original resolved Compose model, original Compose/env file paths and hashes, exact old image IDs, original managed bind sources, protected-container snapshot, private operation log, and a `rollback.compose.json` plus argument-array `rollback_command`. Successful deployments also create `completed.json` with actual images.

These files may contain resolved configuration. They are mode `0600` inside a mode `0700` directory. **Keep them private.** Review logs locally; redact any provider credentials, tokens, subscriber data and private paths before sharing excerpts. The tool does not print Docker/Compose command output.

If application rollback is needed, have the operator review the saved `rollback_command` and confirm the original Compose/env files still match the saved hashes, then execute that argument array on the same server. It uses the original exact images and binds, the complete original stack and the same explicit service list. Keep old images and source directories until acceptance is complete. This is an application rollback: it does not reverse migrations or restore an old database over subsequent payments, sales or invoices. If source/configuration drift prevents a safe rollback, stop and use the retained operational recovery procedure.

After successful apply, complete the release guide's API, authenticated catalogue, invoice delivery, real payment and physical router acceptance steps. Container health checks alone do not establish SMS/email provider delivery or physical network admission.

## Release packager contract

The qualified release packager creates the archive **from the exact approved commit**, using Git's archive metadata:

```sh
git archive --format=tar.gz --prefix=pasofi/ APPROVED_40_CHARACTER_COMMIT -o source.tar.gz
```

Compute the archive's SHA-256 and write `release.json`:

```json
{
  "schema": 1,
  "commit": "APPROVED_FULL_LOWERCASE_40_CHARACTER_SHA",
  "archive_sha256": "LOWERCASE_64_CHARACTER_SHA256_OF_SOURCE_TAR_GZ",
  "services": ["identity", "prepaid-access", "network", "notification", "assistant", "web"],
  "migrations": ["identity", "prepaid-access", "network", "notification", "assistant"]
}
```

The placeholders intentionally fail validation. The manifest must come from the trusted qualified release bundle: hashes detect a mismatch, not an attacker replacing both the archive and manifest. The archive must contain the whole repository under `pasofi/`, must have its Git commit in the tar global `comment` header, and cannot contain links or traversal paths. The source commit is pinned; dependency versions use the checked-in lockfiles and existing Dockerfiles. This tool does not claim a byte-reproducible container build or a signed supply-chain attestation.

## Local safety tests

```sh
python3 -m unittest discover -s 'pasofi-backend/local-tools/manual deployment' -p 'test_release_deploy.py' -v
```

The tests use synthetic archives, Compose models and command mocks. They require no Docker daemon, server connection, credentials or database. They verify refusal paths and the explicit mutation scope; hosted release checks and the operator's production preflight remain required.
