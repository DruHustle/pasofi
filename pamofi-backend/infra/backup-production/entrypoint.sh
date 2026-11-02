#!/bin/sh
set -eu
install -d -m 700 -o postgres -g postgres /run/pgbackrest
/usr/local/bin/pamofi-backup-config "$PGBACKREST_CONFIG"
chown postgres:postgres "$PGBACKREST_CONFIG"
exec /usr/local/bin/docker-entrypoint.sh "$@"
