#!/bin/sh
(
set -eu

# Executed only by the official PostgreSQL entrypoint on an empty, dedicated
# cluster. All real passwords arrive through explicitly mounted secret files.
read_password() {
  [ -f "$1" ] && [ -r "$1" ] || { echo 'Required database secret file is unreadable.' >&2; exit 1; }
  value=$(cat "$1")
  case "$value" in ''|*[!a-fA-F0-9]*) echo 'Database secrets must be random64-character hexadecimal values.' >&2; exit 1;; esac
  [ "${#value}" = 64 ] || { echo 'Database secret has invalid length.' >&2; exit 1; }
  printf '%s' "$value"
}

for service in identity prepaid network notification assistant; do
  case "$service" in
    identity) suffix=identity; migration_file=${IDENTITY_MIGRATE_PASSWORD_FILE:?required}; runtime_file=${IDENTITY_RUNTIME_PASSWORD_FILE:?required};;
    prepaid) suffix=prepaid_access; migration_file=${PREPAID_MIGRATE_PASSWORD_FILE:?required}; runtime_file=${PREPAID_RUNTIME_PASSWORD_FILE:?required};;
    network) suffix=network; migration_file=${NETWORK_MIGRATE_PASSWORD_FILE:?required}; runtime_file=${NETWORK_RUNTIME_PASSWORD_FILE:?required};;
    notification) suffix=notification; migration_file=${NOTIFICATION_MIGRATE_PASSWORD_FILE:?required}; runtime_file=${NOTIFICATION_RUNTIME_PASSWORD_FILE:?required};;
    assistant) suffix=assistant; migration_file=${ASSISTANT_MIGRATE_PASSWORD_FILE:?required}; runtime_file=${ASSISTANT_RUNTIME_PASSWORD_FILE:?required};;
  esac
  export PAMOFI_ROLE_DATABASE="pamofi_$suffix" PAMOFI_ROLE_OWNER="pamofi_${suffix}_owner"
  export PAMOFI_ROLE_MIGRATOR="pamofi_${suffix}_migrate" PAMOFI_ROLE_RUNTIME="pamofi_${suffix}_runtime"
  PAMOFI_ROLE_MIGRATION_PASSWORD=$(read_password "$migration_file")
  PAMOFI_ROLE_RUNTIME_PASSWORD=$(read_password "$runtime_file")
  export PAMOFI_ROLE_MIGRATION_PASSWORD PAMOFI_ROLE_RUNTIME_PASSWORD
  psql -X -q -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:?required}" --dbname postgres --file /opt/pamofi/roles.sql
  unset PAMOFI_ROLE_MIGRATION_PASSWORD PAMOFI_ROLE_RUNTIME_PASSWORD
done
# A dedicated cluster has no reason to let an application connect to the
# maintenance/template databases or create temporary objects there.
psql -X -q -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
REVOKE ALL ON DATABASE postgres FROM PUBLIC;
REVOKE ALL ON DATABASE template1 FROM PUBLIC;
SQL
)
