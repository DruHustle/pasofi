#!/bin/sh
# Executed only when the staging PostgreSQL volume is first initialized.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
\getenv identity_password IDENTITY_DB_PASSWORD
\getenv prepaid_password PREPAID_DB_PASSWORD
\getenv network_password NETWORK_DB_PASSWORD
\getenv notification_password NOTIFICATION_DB_PASSWORD
\getenv assistant_password ASSISTANT_DB_PASSWORD
CREATE ROLE pamofi_identity LOGIN PASSWORD :'identity_password';
CREATE DATABASE pamofi_identity OWNER pamofi_identity;
REVOKE ALL ON DATABASE pamofi_identity FROM PUBLIC;
CREATE ROLE pamofi_prepaid_access LOGIN PASSWORD :'prepaid_password';
CREATE DATABASE pamofi_prepaid_access OWNER pamofi_prepaid_access;
REVOKE ALL ON DATABASE pamofi_prepaid_access FROM PUBLIC;
CREATE ROLE pamofi_network LOGIN PASSWORD :'network_password';
CREATE DATABASE pamofi_network OWNER pamofi_network;
REVOKE ALL ON DATABASE pamofi_network FROM PUBLIC;
CREATE ROLE pamofi_notification LOGIN PASSWORD :'notification_password';
CREATE DATABASE pamofi_notification OWNER pamofi_notification;
REVOKE ALL ON DATABASE pamofi_notification FROM PUBLIC;
CREATE ROLE pamofi_assistant LOGIN PASSWORD :'assistant_password';
CREATE DATABASE pamofi_assistant OWNER pamofi_assistant;
REVOKE ALL ON DATABASE pamofi_assistant FROM PUBLIC;
SQL
