-- Five-second customer polling reads only the newest received accounting time.
-- Existing customer indexes cover live grants or non-null legacy request keys,
-- so they cannot bound this history lookup for every migrated grant.
CREATE INDEX access_grants_customer_accounting_idx
 ON access_grants(customer_id,last_accounting_at DESC NULLS LAST);
