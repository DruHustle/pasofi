# Onesa PamoFi backup operations

These scripts record the PamoFi-specific scheduler installed on the owner's Onesa UG Backend. They require Linux, Docker, systemd, passwordless sudo, the existing `pamofi-production-postgres-1` container, and the protected production configuration under `/home/ubuntu/pamofi/production`. They do not initialize the database, create credentials, activate the backup overlay, or configure the public API.

Run them on the intended host only after verifying an actual encrypted backup and a separate restore:

```sh
bash 'pasofi-backend/local-tools/manual deployment/onesa/install-backup-timers.sh'
bash 'pasofi-backend/local-tools/manual deployment/onesa/install-restore-timer.sh'
```

The installers refuse to overwrite existing scheduler files. The weekly full backup, Monday–Saturday differential backups, and hourly repository check share a lock. The monthly drill restores from Backblaze to its own temporary Docker volume and network, checks the recorded cluster ID and all five migration ledgers, and removes its own temporary resources. It uses capped CPU and memory and does not publish a port. An independent restore on another machine remains useful for host-loss recovery.

Failures are recorded in the systemd journal; **external alert delivery is not configured by these scripts**. Backblaze retains old object versions under the currently selected bucket lifecycle, so storage and charges can grow despite pgBackRest retention. Review the bucket policy and monitor usage before changing or deleting retained versions. Keep the independently protected backup credentials, encryption key, application secrets, and internal CA recovery material available outside the host.

The script uses a fixed private drill subnet `10.245.244.0/24` and refuses an overlap with an existing Docker network. Before enabling it on any other host, assess host routes, private tunnels, resource capacity, and whether the configured paths and Docker project belong to PamoFi. Do not use it against another project's volume.

## HTTPS and operational alerts

The PamoFi deployment uses a Vercel frontend at `https://pamofi.onesa.eu` and an API at `https://api.pamofi.onesa.eu`, with the API DNS-only record pointing to Onesa UG Backend. The public gateway uses the static private address `10.245.242.10` and publishes TCP 443 only. Oracle's PamoFi-specific security group permits TCP 80 for certificate validation and TCP 443 for the authenticated gateway. The host firewall accepts port 443 only for that gateway address; TCP 80 is opened temporarily by the certificate scripts during validation. These scripts do not attach the Oracle security group or alter unrelated Onesa firewall rules.

`issue-certificate.sh` records the historical initial, root-run, one-time certificate issuance procedure. `issue-api-certificate.sh` records the subsequent API-only certificate issuance; use the API-only lineage for renewals because the website hostname points to Vercel. It refuses existing certificate files and requires the DNS record and Oracle security group to be configured first. `install-https-operations.sh` installs the PamoFi firewall rule and daily renewal timer, refusing to overwrite existing units. Its renewal procedure checks the exact hostname and certificate/key match and recreates only the PamoFi gateway when the certificate changes. The operator must separately verify public DNS, certificate trust, authenticated-proxy denial, and a staging renewal before go-live. The certificate, ACME account key, and app secrets belong in an encrypted independent recovery copy; never include the one-time administrator password.

`install-alerts.sh` records the Onesa-specific health and notification setup. It uses an official pinned OCI CLI container with the instance identity, a dedicated PamoFi notification topic and a narrowly scoped Oracle policy that permits this instance to publish only within the PamoFi alerts compartment. It adds PamoFi-only systemd failure hooks and a recurring HTTPS/container/disk/certificate check, with per-unit notification rate limiting. The configured email subscription was confirmed and a test message reached the operator; verify delivery again if notification settings change. A separate Oracle Monitoring absence alarm reports when the shared host stops emitting compute metrics. The exact topic and IAM policy must be reviewed before using these scripts on any other account or host.
