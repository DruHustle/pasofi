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

## Existing services with different Compose origins

Some installations contain independently deployed applications, a separately retained PostgreSQL definition and protected RADIUS services. Their original working directories and overlay lists can legitimately differ. Ordinary automatic discovery still refuses that layout; never relabel or recreate a protected container to make the labels agree.

The direct-server `--capture-baseline` operation verifies those origins separately and prepares a private combined model. It does not apply a release. Run it with the qualified package on the existing Docker host, using an account able to read its protected configuration and database records. Create a new private directory for this operation:

```sh
mkdir -m 700 baseline-review
python3 -I -B -S ./release-deploy.py \
  --manifest ./release.json --archive ./source.tar.gz \
  --capture-baseline ./baseline-review/baseline.json
```

Capture checks every current service's exact container/image identity, recorded Compose configuration hash, ordered input files and file hashes. It renders each origin with its own recorded environment files and retains the existing environment, mount, secret, tmpfs, network, DNS-alias and port checks. A missing environment-file label is accepted only for an existing complete staged JSON model; an empty interpolation environment is used, and both its actual rendered hash and runtime configuration must agree. No historical `.env` file is guessed.

An original shared environment file may have changed after an independent service deployment, or its launch may have supplied additional shell variables. After recovering the specific historical values from the observed service and retained installation evidence, an operator can add one explicit private supplemental file for that service during capture:

```sh
  --origin-env network=/absolute/private/historical-network.env
```

The file is appended after that service's recorded environment files. It must be mode `0600` inside a private `0700` directory. Capture still requires the exact original recorded Compose service hash, immutable image and all runtime checks to match; this option cannot accept a new configuration. It applies only to the named service's origin, so protected RADIUS qualification inputs cannot change the selected network or prepaid origins. The baseline records both the original input hashes and the supplemental file hash, and rechecks them after locking and before migration. Keep the supplemental file private and unchanged through acceptance and rollback. Neither the existing environment files nor running containers are edited.

A staged JSON runtime definition can omit its migration profile. In that case, explicitly select another **observed and verified** origin that contains the same service's original migration definition. For example, if the current network origin contains both original jobs, add:

```sh
  --migration-origin identity=network \
  --migration-origin prepaid-access=network
```

These options belong to capture only. Each selected job must still be that application's `migrate` command, with the production Node entrypoint, all three required read-only configuration binds, matching production settings and role prefix. The migration URL must identify the same database and retained PostgreSQL endpoint as the current application's mounted runtime URL, using the distinct service-specific migration role. Custom hosts, DNS, links and resolver mounts cannot redirect that endpoint. A read-only query verifies the database owner and the migrator's owner-role membership. Both credential-file hashes are retained privately. No password, resolved environment value or URL is printed. Conflicting shared resource definitions stop capture instead of allowing one service's model to overwrite another.

Successful capture creates three private files beside one another:

- `baseline.json`: per-service provenance, retained database identity and hashes; the source release is fixed.
- `baseline.json.compose.json`: the verified combined model. **It can contain resolved secrets and must remain private.**
- `baseline.json.empty.env`: an intentionally empty interpolation input, retained so future Compose labels identify an actual file.

Compose's [JSON serializer](https://github.com/docker/compose/blob/v2.40.3/cmd/compose/config.go) doubles dollar signs for replay, including literal Nginx regular expressions. The coordinator decodes that serialization once before comparing actual runtime values, then escapes values once when writing executable baseline, upgrade and rollback models. It retains exact environment equality and requires an actual Compose rendering to reproduce the verified values before accepting the files. Capture prints the baseline's SHA-256 for the operational record. Review the original service mappings and successful capture result, then run the explicit preflight:

```sh
python3 -I -B -S ./release-deploy.py \
  --manifest ./release.json --archive ./source.tar.gz \
  --baseline ./baseline-review/baseline.json
```

Repeat that exact command with `--apply` after the preflight passes and the existing release records show no uncertain earlier operation. Baseline mode always qualifies the fresh encrypted backup and exact-label isolated restore before building or migrating, just like `--discover-existing`. It locks every observed working directory, revalidates all service origins after taking the locks and immediately before migration, and preserves the existing phased rollout and protected-container checks. It cannot be combined with `--host`, `--discover-existing`, manually supplied environment files or a caller-supplied database ID.

Keep all three baseline files, the original referenced files and the private release record through acceptance and rollback. The record includes the original service provenance. A changed file, credential, image, container or runtime configuration invalidates the captured baseline. Do not edit its hashes to retry an uncertain release: inspect the retained operation record and actual running state. The existing Mac launcher is unchanged; this explicit mode is for an operator already connected to the Docker host.

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
python3 -B -m unittest discover -s 'pasofi-backend/local-tools/manual deployment' -p 'test_*.py' -v
```

The tests use synthetic archives, Compose models and command mocks. They require no Docker daemon, server connection, credentials or database. The baseline cases exercise independently recorded origins, migration database authority, configuration and credential drift, backup failures, project locks and protected-service preservation. The tests verify refusal paths and the explicit mutation scope; actual Compose rendering, the live database checks and the operator's production preflight remain required.
