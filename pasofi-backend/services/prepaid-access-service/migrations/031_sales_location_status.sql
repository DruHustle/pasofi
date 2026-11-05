-- Sales availability is independent of NAS trust and the global commerce and
-- network gates. A version protects an administrator's reviewed status from
-- changes by another administrator (including enabled -> paused -> enabled).
ALTER TABLE sales_locations ADD COLUMN status_version bigint NOT NULL DEFAULT 1 CHECK (status_version > 0);

CREATE FUNCTION bump_sales_location_status_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.enabled IS DISTINCT FROM OLD.enabled THEN
  NEW.status_version := OLD.status_version + 1;
 ELSE
  NEW.status_version := OLD.status_version;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER sales_location_status_version BEFORE UPDATE ON sales_locations
 FOR EACH ROW EXECUTE FUNCTION bump_sales_location_status_version();

-- The append-only audit event also retains the original response for exact
-- retries. Runtime permissions already allow INSERT/SELECT, never UPDATE.
CREATE UNIQUE INDEX commerce_audit_site_status_request ON commerce_audit(actor_id,(details->>'requestId'))
 WHERE action = 'site.status';
