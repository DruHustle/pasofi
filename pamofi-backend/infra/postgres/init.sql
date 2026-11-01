-- Disposable local demo only. Never use these credentials in production.
CREATE ROLE pamofi_identity LOGIN PASSWORD 'demo_only_change_me';
CREATE DATABASE pamofi_identity OWNER pamofi_identity;
REVOKE ALL ON DATABASE pamofi_identity FROM PUBLIC;
CREATE ROLE pamofi_prepaid_access LOGIN PASSWORD 'demo_only_change_me';
CREATE DATABASE pamofi_prepaid_access OWNER pamofi_prepaid_access;
REVOKE ALL ON DATABASE pamofi_prepaid_access FROM PUBLIC;
CREATE ROLE pamofi_network LOGIN PASSWORD 'demo_only_change_me';
CREATE DATABASE pamofi_network OWNER pamofi_network;
REVOKE ALL ON DATABASE pamofi_network FROM PUBLIC;
CREATE ROLE pamofi_notification LOGIN PASSWORD 'demo_only_change_me';
CREATE DATABASE pamofi_notification OWNER pamofi_notification;
REVOKE ALL ON DATABASE pamofi_notification FROM PUBLIC;
CREATE ROLE pamofi_assistant LOGIN PASSWORD 'demo_only_change_me';
CREATE DATABASE pamofi_assistant OWNER pamofi_assistant;
REVOKE ALL ON DATABASE pamofi_assistant FROM PUBLIC;
\connect pamofi_prepaid_access
SET ROLE pamofi_prepaid_access;
CREATE TABLE bundle_versions (id text PRIMARY KEY, price_minor integer NOT NULL CHECK (price_minor > 0), currency char(3) NOT NULL, byte_limit bigint NOT NULL CHECK (byte_limit > 0), validity_seconds integer NOT NULL CHECK (validity_seconds > 0), published boolean NOT NULL DEFAULT false);
INSERT INTO bundle_versions VALUES
('mini',50,'USD',2000000000,259200,true),('flex',100,'USD',5000000000,604800,true),('week',300,'USD',20000000000,604800,true),('fortnight',500,'USD',35000000000,1209600,true),('month',1000,'USD',75000000000,2592000,true);
