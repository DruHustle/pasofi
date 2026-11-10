# Read the existing Pasofi installation from your Mac

Double-click **`hotspot-readiness.command`** in the extracted package. It automatically tries the existing aliases in `mac-connection.json`: `onesa-portal-worker`, then the provided public fallback `onesa-portal-worker-public` if needed. There are no connection prompts.

From Terminal in that folder:

```sh
/bin/bash ./hotspot-readiness.command
```

Python 3.9+, OpenSSH, an available SSH key/agent and trusted server host records must already exist on the Mac. The server needs Python 3.9+ and the existing account's Docker access. The collector does not install software, accept an unknown host key, change SSH settings or ask for credentials.

## What it observes

| Section | Recorded evidence |
| --- | --- |
| Connection | Which provided alias connected; fixed sanitized failure categories |
| Project and stack | Unambiguous existing Pasofi project, working directory and complete ordered Compose files |
| Environment references | Ordered environment-file paths only when all containers carry a consistent record |
| Database identity | Independently retained identifier compared with the running cluster |
| Services | Presence, running/health state and recorded source revisions |
| Feature gates | An allowlist of boolean cash, network, RADIUS and fleet gates; other values remain unknown |
| NAS registry | Aggregate gateway/site counts through a read-only query, with no router credentials or customer data |
| Remaining work | Missing records and actual device/customer acceptance still required |

The retained identifier is read from `/home/ubuntu/pamofi/production/cluster-system-id`. A missing, symlinked, writable-by-others, malformed or mismatched record stays unresolved; the collector never adopts the currently running database as an unverified expected identity. The historical `compose.env` path is a candidate reference only and is not substituted for the recorded complete environment-file order.

The collector streams fixed Python through SSH and creates no remote staging files. Commands are read-only, bounded by time/output limits and restricted to the required observations. It does not fetch secret files, render/export environment values, deploy applications, send a message, create a transaction or configure a router.

## Read the result

The Terminal prints a new private JSON file under `PasoFi_Readiness`. It contains sanitized infrastructure references and the retained cluster identifier. Keep it private and share only the relevant sections. Raw Docker inspection, command diagnostics, secret values and customer identities are excluded, and the Mac validates the entire received report before saving it.

Successful collection can still report blockers. `customer_ready` remains `false` and `physical_checks` remains `not_performed`. A report cannot prove Wi-Fi admission, real receipt delivery, quota enforcement or cross-site operation.

For an advanced explicit target, the collector still supports:

```sh
/bin/bash ./hotspot-readiness.command --host onesa-portal-worker
```

Add `--project` only if a known project needs to be selected. The normal automatic deployment launcher uses the recorded, unambiguous project without asking for these fields. See `MAC_DEPLOY.md` for the one-action deployment and automatic postchecks.
