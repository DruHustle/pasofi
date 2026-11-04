#!/bin/sh
# Docker Desktop can present a read-only bind mount as executable while the
# underlying mount prohibits execution. Copy the reviewed init script into the
# container's own filesystem before invoking the selected image's entrypoint.
# The official entrypoint runs it only when initializing an empty cluster.
set -eu
cp /opt/pamofi/init.sh /docker-entrypoint-initdb.d/10-pamofi.sh
chmod 755 /docker-entrypoint-initdb.d/10-pamofi.sh
# The production backup image must render its private pgBackRest configuration
# before PostgreSQL starts. Do not silently bypass that wrapper: WAL archiving
# would fail while PostgreSQL could otherwise appear healthy.
if [ -e /usr/local/bin/pamofi-backup-entrypoint ]; then
  [ -x /usr/local/bin/pamofi-backup-entrypoint ] || { echo 'Backup entrypoint is not executable.' >&2; exit 1; }
  exec /usr/local/bin/pamofi-backup-entrypoint "$@"
fi
if [ -n "${PGBACKREST_CONFIG:-}" ]; then
  echo 'Backup configuration is set but the backup entrypoint is missing.' >&2
  exit 1
fi
exec /usr/local/bin/docker-entrypoint.sh "$@"
