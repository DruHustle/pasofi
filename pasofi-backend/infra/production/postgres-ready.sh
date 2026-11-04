#!/bin/sh
# PostgreSQL accepting TCP does not mean first-time initialization completed.
# Use the bootstrap role over the local socket to inspect the fixed installation
# identities. This also works with existing installations and restored clusters;
# it does not write a marker or change any data.
set -eu
pg_isready -h 127.0.0.1 -U "${POSTGRES_USER:?required}" -d postgres >/dev/null
result=$(psql -XAtq -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres --file /opt/pamofi/postgres-ready.sql)
[ "$result" = ready ]
