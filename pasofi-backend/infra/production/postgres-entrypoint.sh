#!/bin/sh
# Docker Desktop can present a read-only bind mount as executable while the
# underlying mount prohibits execution. Copy the reviewed init script into the
# container's own filesystem before invoking the unchanged official entrypoint.
# The official entrypoint runs it only when initializing an empty cluster.
set -eu
cp /opt/pamofi/init.sh /docker-entrypoint-initdb.d/10-pamofi.sh
chmod 755 /docker-entrypoint-initdb.d/10-pamofi.sh
exec /usr/local/bin/docker-entrypoint.sh "$@"
