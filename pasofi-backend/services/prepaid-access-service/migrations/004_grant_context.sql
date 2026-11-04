-- Existing development grants remain nullable for safe migration; all new code requires both values.
ALTER TABLE access_grants ADD COLUMN nas_id uuid;
ALTER TABLE access_grants ADD COLUMN request_key uuid;
CREATE UNIQUE INDEX access_grants_customer_request_idx ON access_grants(customer_id,request_key) WHERE request_key IS NOT NULL;
