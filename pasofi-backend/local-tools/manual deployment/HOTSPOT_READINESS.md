# Collect the existing hotspot installation from your Mac

Use `hotspot-readiness.command` when the remaining deployment details are on the Mac and Oracle server, rather than in the current chat. It gathers a private report through **your existing, trusted Oracle SSH alias**. It does not deploy software, enable cash sales or customer Wi-Fi, configure a router, send a message or perform a transaction.

The collector needs Python 3.9 or newer and OpenSSH on the Mac. Oracle needs Python 3.9 or newer and the existing account's Docker access. The optional NAS count runs Node inside the existing network container; Node and Docker are not required on the Mac. No software is installed and no automatic `sudo` is used.

## Run once from the extracted Mac package

Keep `hotspot-readiness.command` and `hotspot-readiness.py` together. Double-click the command in Finder, or open Terminal in that folder and run:

```sh
/bin/bash ./hotspot-readiness.command
```

Enter the **existing SSH alias**. For the optional Compose project prompt, press Return unless you already need to select a known installation. Do not enter passwords, private keys or environment-file contents.

The checked-in `pasofi-routeros/site-01/prepare-pasofi-certificate.py` helper previously used **`onesa-portal-worker`**. Check whether that is the established Oracle alias in the original Mac's SSH configuration. It is a historical candidate, not an assumed current connection; the collector never selects or tries it automatically.

The collector requires an already trusted host key and available SSH key/agent. Unknown or changed host keys are rejected. It does not save a new host key, forward the SSH agent or create port forwards. If access is unavailable, resolve the ordinary connection on this Mac using the installation's trusted record, then repeat the collector. It does not search for hosts or try alternative credentials.

The result is a new JSON file inside `PasoFi_Readiness` beside the interactive launcher. The directory is private (`0700`) and the file is private (`0600`). The Terminal prints the exact report location and retains the result until you press Return. Existing report files are not overwritten.

For explicit arguments:

```sh
/bin/bash ./hotspot-readiness.command --host YOUR_EXISTING_SSH_ALIAS
```

Add `--project YOUR_EXISTING_COMPOSE_PROJECT` only to select the intended installation. An optional `--output '/absolute/new/report.json'` creates a new private file at that local path; its parent directory must already exist. Explicit argument mode uses the current Terminal directory for its default report folder.

## What the report contains

| Section | Evidence collected |
| --- | --- |
| Project | Candidate PasoFi Compose projects with a `prepaid-access` container; one explicit or unambiguous project is selected. |
| Stack | Current working directory and ordered Compose files, preserving the deployment engine's ordered-superset rule. |
| Environment references | The exact environment-file order only when every selected container carries the same complete, usable record. Missing or inconsistent metadata stays unresolved. Environment-file contents are never read. |
| Retained database identity | The historical installation record is compared with the running PostgreSQL cluster. The current cluster identifier is never adopted as a missing expected identifier. |
| Services | Presence, running/health state and a valid image source revision when available. Container command lines, inspection output and logs are excluded. |
| Gates | An allowlist of existing boolean cash, network, RADIUS and router-control settings. Missing or unexpected values are `unknown`; their raw values are not printed. |
| NAS registry | Counts of registered/enabled gateways and distinct sites, through the network service's existing runtime role in a read-only transaction with short timeouts. No router credential, customer identity or voucher is returned. |
| Remaining inputs | Unresolved installation references plus actual backup/restore, router-inspection and customer-path acceptance evidence. |

The collector checks two exact **historical candidates**, identified by the checked-in Onesa deployment scripts:

- `/home/ubuntu/pamofi/production/compose.env`, recorded by `onesa/install-https-operations.sh`. Its existence does not establish today's complete environment-file list or precedence.
- `/home/ubuntu/pamofi/production/cluster-system-id`, used by `onesa/install-restore-timer.sh` as the retained expected identity. A missing, symlinked, writable-by-others, malformed or mismatched record remains a blocker. It is not created or replaced.

The collector streams fixed Python through SSH and creates no remote staging files. Its remote commands inspect Docker metadata, read that retained identity and run fixed read-only database observations. It does not read secret files onto the Mac, render or export a resolved Compose environment, or print command failure output. Commands have time and output limits. A failed optional read is reported as unverified rather than treated as success.

Before saving, the Mac validates and reconstructs the complete report schema, including every nested field. Unexpected fields, invalid gate values, paths, counts, blocker codes or a different selected project discard the remote report and produce a sanitized incomplete result. Remote paths are checked as references; they are not opened or inspected on the Mac.

Compose's environment-file metadata is version-dependent; see its [recorded label contract](https://github.com/docker-archive/compose-cli/issues/965). The ordinary release preflight still verifies actual configuration, secrets, mounts, networks, ports and database identity before any upgrade. The collector does not replace that preflight.

## Use the result to finish the deployment

Review the report locally. It contains nonsecret infrastructure references and the retained cluster identity, so keep it private and share only the relevant sanitized sections. Never attach full environment files, keys, raw Docker inspection, database connection strings or private deployment records.

A successful command exit means **collection completed**, even when the report lists blockers. `customer_ready` is always `false` and `physical_checks` is always `not_performed`: a report cannot prove actual Wi-Fi, captive sign-in, cash issuance, quota enforcement or cross-site behavior. An SSH/collection failure still saves a sanitized incomplete report and exits nonzero.

Use the proven installation references with `release-deploy.command`, following [MAC_DEPLOY.md](MAC_DEPLOY.md). Resolve each missing or inconsistent record; do not substitute the historical candidate or current cluster ID merely to proceed. After backend preflight and the reviewed upgrade, follow the [cash hotspot launch sequence](../../docs/CASH_HOTSPOT_LAUNCH.md) through router configuration, controlled cash/network tests and [two-site acceptance](../../docs/TWO_SITE_HOTSPOT_ACCEPTANCE.md). In the extracted package, open the included `CASH_HOTSPOT_LAUNCH.md` directly. Digital payment providers remain governed by their separate integration qualification.

## Maintainer verification

Run the offline collector and deployment tests from a source checkout:

```sh
python3 -m unittest discover -s 'pasofi-backend/local-tools/manual deployment' -p 'test_hotspot_readiness.py' -v
python3 -m unittest discover -s 'pasofi-backend/local-tools/manual deployment' -p 'test_release_deploy*.py' -v
```

These tests exercise command and output boundaries, secret redaction, ambiguous projects, missing/mismatched retained records, env-file precedence, private output permissions and literal Mac prompt input. They do not contact Oracle or qualify physical routers.
