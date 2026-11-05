# Deploy an existing PasoFi installation from your Mac

Use the qualified release ZIP prepared for this deployment. Its launcher upgrades the existing Oracle Docker Compose installation from the exact commit and archive hash in `release.json`. It first checks the installation and shows a deployment plan. You then choose whether to apply that plan.

The Mac launcher reuses `release-deploy.sh` and the Python deployment engine. You do not need Git, Node.js or Docker on your Mac. The existing Linux server needs Python 3.9 or newer, Docker and Docker Compose, with the PasoFi installation already running.

## 1. Extract and keep the release files together

In Finder, double-click the release ZIP to extract it. Open the extracted folder and keep these files beside one another:

- `release-deploy.command` — the Mac entry point.
- `release-deploy.sh` and `release-deploy.py` — the deployment engine and its shell entry point.
- `release.json` and `source.tar.gz` — the pinned release manifest and source archive.
- `MAC_DEPLOY.md` and the supplied release and router-fleet guides.

Leave `source.tar.gz` compressed. Folder names containing spaces are supported. Use the manifest and archive from the same qualified bundle; the deployment stops if their hashes or Git commit do not match.

## 2. Check the Mac and existing SSH connection

Open **Terminal** from Applications → Utilities. Check the existing tools:

```sh
python3 --version
ssh -V
command -v scp
```

Python must report **3.9 or newer**. If a required tool is missing, install it through your normal trusted setup process and repeat the check. The launcher does not install software or change your SSH configuration.

Use the existing SSH alias for the Onesa backend. The examples below use `YOUR_SSH_ALIAS`; replace it with that existing alias, without angle brackets.

```sh
ssh YOUR_SSH_ALIAS
```

Confirm that this is the intended server. If SSH presents a host fingerprint, verify it against your independently trusted server record before accepting it. An unexpected changed fingerprint needs investigation. Once signed in, confirm that Python 3.9 or newer and the existing Docker Compose installation are available, then run `exit` to return to your Mac.

The SSH account must already be able to access Docker, read the installation's protected configuration files and create its private deployment lock/record. Load the existing encrypted SSH key into your normal SSH agent if necessary. You can check the agent with `ssh-add -l`. The deployment uses OpenSSH batch mode: it needs an available key and trusted host record, and will not pause to request a key password. It does not automatically use `sudo` or change host-key verification.

Have these existing installation details ready:

- **SSH alias** for the intended Oracle server.
- **Absolute server paths to the existing Compose environment files**, in their original order. Multiple files are supported; later files retain their existing precedence.
- **PostgreSQL system identifier from your retained installation or backup record.** This is a cluster identifier, not a database name or Docker container ID. If the record is unavailable, independently establish the correct production cluster before deploying; do not adopt whatever identifier an unfamiliar server returns.
- **Existing Compose project name**, only if you know it or more than one PasoFi installation makes discovery ambiguous.

The launcher asks for names, paths and the database identifier. Do not enter passwords, private-key contents, router credentials or environment-file contents into its prompts. Keep a recent successful protected database backup and its restore evidence, with enough server disk space for the new images and retained rollback images.

## 3. Run the Mac launcher

In the extracted folder, double-click **`release-deploy.command`**. Terminal opens the interactive launcher.

If you prefer to start from Terminal, type `cd ` with a trailing space, drag the extracted folder from Finder into the Terminal window, and press Return. Then run:

```sh
/bin/bash ./release-deploy.command
```

If the extracted command has lost its executable permission, the Terminal command above still works. To restore the executable bit on that file:

```sh
chmod u+x ./release-deploy.command
```

The launcher is compatible with macOS's bundled Bash 3.2. It does not depend on a newer Homebrew shell.

Enter the requested details:

1. Enter your existing SSH alias.
2. Enter the first absolute environment-file path **on the server**. Add any additional environment files on separate lines, in their original order. Press Return on an empty line after the last file. In these prompts, enter paths literally, **without surrounding quotes**; spaces are preserved.
3. Enter the retained PostgreSQL system identifier.
4. Enter the existing Compose project name, or press Return to let the deployment discover it. If discovery reports multiple projects, rerun the launcher with the correct existing project name.

The launcher now runs **preflight**. This checks the pinned archive, actual Compose project and overlays, retained database identity, running mounts, networks, environment and ports. It stages temporary files but does not change running containers, database contents, secrets or persistent volumes.

Review the reported release, project and selected services. If preflight fails, the launcher stops before offering apply. Resolve the specific reported installation mismatch; keep the existing complete Compose configuration.

After a successful preflight, type **`APPLY`** exactly to deploy. Any other answer, including an empty line, finishes after preflight. Apply reuses the same arguments and the Python engine repeats preflight before the upgrade. The Terminal window keeps the outcome visible until you press Return.

## 4. Optional: use explicit Terminal arguments

From the extracted release folder, the same launcher accepts the deployment engine's arguments. Explicit arguments pass through unchanged and use the current Terminal directory for relative paths.

Run preflight first:

```sh
./release-deploy.command \
  --host YOUR_SSH_ALIAS \
  --manifest ./release.json \
  --archive ./source.tar.gz \
  --env-file '/absolute/existing/production.env' \
  --expected-database-id YOUR_RECORDED_SYSTEM_ID
```

For multiple environment files, repeat `--env-file` in the original order:

```sh
  --env-file '/absolute/existing/production.env' \
  --env-file '/absolute/existing/qualified overlays.env'
```

Add `--project EXISTING_PROJECT` only when needed to select the known installation. Replace all placeholders with existing values. Quote paths containing spaces when entering a **Terminal command**; do not add those quotes when answering the interactive prompts.

After a successful preflight and review, repeat the complete command with `--apply` added. Explicit command-line mode delegates directly to the Python engine, so adding `--apply` is the operator's application request; it does not show the interactive `APPLY` prompt again. The engine still performs its normal preflight. You can use `/bin/bash ./release-deploy.command` in place of `./release-deploy.command` if needed.

## 5. Review the result and complete acceptance

Apply builds the selected application images on the server, runs their owned pending migrations, updates the selected applications and gateways, and waits for their health checks. It retains the full existing Compose overlay order, protected database/RADIUS containers, existing feature gates and provider settings. An already-mounted captive portal is rebuilt with its dedicated configuration.

The deployment prints the private server release-record location. Keep the original image IDs, source/configuration paths and rollback record until acceptance is complete. These records can contain resolved configuration and must remain private. If apply stops partway through, some builds, migrations or application replacements may already have completed; inspect the private record before retrying. The saved application rollback restores application images and configuration binds, not an older database over later transactions.

Follow the supplied release guide to check the public API, authenticated staff/customer flows, catalogue, invoices and the dedicated captive portal. Container health alone does not prove real email/SMS receipt or physical hotspot operation.

For **central router management**, follow `ROUTER_FLEET.md` for the required overlay, protected configuration and router enrollment procedure. The general deployment launcher preserves existing overlays; it does not enroll routers or infer a new router-fleet overlay. After the documented setup, qualify the authorized staff access and router configuration flows, then perform the physical hotspot tests with the actual routers.

These instructions and a prepared package are not evidence that Oracle or any router has already been updated. Record the actual release and acceptance results after running the deployment.

## Launcher verification

The Mac launcher tests run offline with a recording engine stub. They check exact argument handling, paths containing spaces, original environment-file order, unexecuted shell-looking input, cancellation and failure handling:

```sh
python3 -m unittest discover \
  -s 'pasofi-backend/local-tools/manual deployment' \
  -p 'test_release_deploy_mac.py' -v
```

This command is for a source checkout. It requires no SSH connection, Docker daemon, production credentials or database.
