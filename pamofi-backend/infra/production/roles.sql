\set ON_ERROR_STOP on
\getenv database_name PAMOFI_ROLE_DATABASE
\getenv owner_role PAMOFI_ROLE_OWNER
\getenv migration_role PAMOFI_ROLE_MIGRATOR
\getenv runtime_role PAMOFI_ROLE_RUNTIME
\getenv migration_password PAMOFI_ROLE_MIGRATION_PASSWORD
\getenv runtime_password PAMOFI_ROLE_RUNTIME_PASSWORD

CREATE ROLE :"owner_role" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE :"migration_role" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD :'migration_password';
CREATE ROLE :"runtime_role" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 12 PASSWORD :'runtime_password';
GRANT :"owner_role" TO :"migration_role" WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;

CREATE DATABASE :"database_name" OWNER :"owner_role" TEMPLATE template0;
REVOKE ALL ON DATABASE :"database_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database_name" TO :"migration_role", :"runtime_role";
\connect :database_name
SET ROLE :"owner_role";
ALTER SCHEMA public OWNER TO :"owner_role";
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO :"runtime_role";

-- Global defaults matter: a per-schema revoke cannot remove PUBLIC's default
-- function EXECUTE privilege. Future objects fail closed until reviewed grants.
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" REVOKE ALL ON TABLES FROM PUBLIC, :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" REVOKE ALL ON SEQUENCES FROM PUBLIC, :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" REVOKE ALL ON ROUTINES FROM PUBLIC, :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" REVOKE ALL ON TYPES FROM PUBLIC, :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" REVOKE ALL ON SCHEMAS FROM PUBLIC, :"runtime_role";
RESET ROLE;
