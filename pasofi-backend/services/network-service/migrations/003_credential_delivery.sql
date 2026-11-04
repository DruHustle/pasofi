-- Existing lab-only fixtures may be verifier-only; issued credentials use all
-- three columns so an authorized retry can recover the same encrypted secret.
ALTER TABLE radius_credentials ADD COLUMN request_key uuid;
ALTER TABLE radius_credentials ADD COLUMN encrypted_secret bytea;
ALTER TABLE radius_credentials ADD COLUMN secret_key_version integer;
ALTER TABLE radius_credentials ADD CONSTRAINT credential_delivery_fields CHECK (
 (request_key IS NULL AND encrypted_secret IS NULL AND secret_key_version IS NULL) OR
 (request_key IS NOT NULL AND encrypted_secret IS NOT NULL AND octet_length(encrypted_secret)>=28 AND secret_key_version > 0)
);
CREATE UNIQUE INDEX radius_credential_request_key ON radius_credentials(customer_id,request_key) WHERE request_key IS NOT NULL;
