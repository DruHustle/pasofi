-- Existing short-lived references remain readable, but cannot authorize a new
-- sale without a quote. Committed receipts and idempotent sale recovery survive.
ALTER TABLE receipt_pairings
 ADD COLUMN bundle_id text REFERENCES bundle_versions(id),
 ADD COLUMN site_id uuid REFERENCES sales_locations(id),
 ADD COLUMN site_name text,
 ADD COLUMN price_minor integer,
 ADD COLUMN currency text,
 ADD COLUMN byte_limit bigint,
 ADD COLUMN validity_seconds integer,
 ADD COLUMN cancelled_at timestamptz,
 ADD CONSTRAINT receipt_pairing_quote CHECK (
  (bundle_id IS NULL AND site_id IS NULL AND site_name IS NULL AND price_minor IS NULL AND currency IS NULL AND byte_limit IS NULL AND validity_seconds IS NULL)
  OR (bundle_id IS NOT NULL AND site_id IS NOT NULL AND site_name IS NOT NULL AND price_minor IS NOT NULL AND price_minor>0 AND currency IS NOT NULL AND currency ~ '^[A-Z]{3}$' AND byte_limit IS NOT NULL AND byte_limit>0 AND validity_seconds IS NOT NULL AND validity_seconds>0)),
 ADD CONSTRAINT receipt_pairing_cancelled_unsold CHECK (cancelled_at IS NULL OR sale_id IS NULL);

CREATE FUNCTION preserve_receipt_pairing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW) - ARRAY['sale_id','cancelled_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['sale_id','cancelled_at'])
    OR (OLD.sale_id IS NOT NULL AND NEW.sale_id IS DISTINCT FROM OLD.sale_id)
    OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at) THEN
  RAISE EXCEPTION 'Cash references are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER receipt_pairing_immutable BEFORE UPDATE ON receipt_pairings FOR EACH ROW EXECUTE FUNCTION preserve_receipt_pairing();
