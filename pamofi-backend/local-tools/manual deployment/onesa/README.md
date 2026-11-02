# Onesa PamoFi backup operations

These scripts record the PamoFi-specific scheduler installed on the owner's Onesa UG Backend. They require Linux, Docker, systemd, passwordless sudo, the existing `pamofi-production-postgres-1` container, and the protected production configuration under `/home/ubuntu/pamofi/production`. They do not initialize the database, create credentials, activate the backup overlay, or configure the public API.

Run them on the intended host only after verifying an actual encrypted backup and a separate restore:

```sh
bash 'pamofi-backend/local-tools/manual deployment/onesa/install-backup-timers.sh'
bash 'pamofi-backend/local-tools/manual deployment/onesa/install-restore-timer.sh'
```

The installers refuse to overwrite existing scheduler files. The weekly full backup, Monday–Saturday differential backups, and hourly repository check share a lock. The monthly drill restores from Backblaze to its own temporary Docker volume and network, checks the recorded cluster ID and all five migration ledgers, and removes its own temporary resources. It uses capped CPU and memory and does not publish a port. An independent restore on another machine remains useful for host-loss recovery.

Failures are recorded in the systemd journal; **external alert delivery is not configured by these scripts**. Backblaze retains old object versions under the currently selected bucket lifecycle, so storage and charges can grow despite pgBackRest retention. Review the bucket policy and monitor usage before changing or deleting retained versions. Keep the independently protected backup credentials, encryption key, application secrets, and internal CA recovery material available outside the host.

The script uses a fixed private drill subnet `10.245.244.0/24` and refuses an overlap with an existing Docker network. Before enabling it on any other host, assess host routes, private tunnels, resource capacity, and whether the configured paths and Docker project belong to PamoFi. Do not use it against another project's volume.
