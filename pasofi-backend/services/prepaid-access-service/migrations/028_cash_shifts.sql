CREATE TABLE cash_shifts (
 id uuid PRIMARY KEY,
 agent_id uuid NOT NULL,
 site_id uuid NOT NULL REFERENCES sales_locations(id),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 request_key uuid NOT NULL,
 opening_minor bigint NOT NULL CHECK(opening_minor BETWEEN 0 AND 1000000000000),
 opened_at timestamptz NOT NULL DEFAULT now(),
 closed_at timestamptz,
 close_key uuid,
 counted_minor bigint CHECK(counted_minor BETWEEN 0 AND 1000000000000),
 expected_minor bigint,
 close_note text,
 UNIQUE(agent_id,request_key),
 CHECK ((closed_at IS NULL AND close_key IS NULL AND counted_minor IS NULL AND expected_minor IS NULL AND close_note IS NULL)
 OR (closed_at IS NOT NULL AND close_key IS NOT NULL AND counted_minor IS NOT NULL AND expected_minor IS NOT NULL AND close_note IS NOT NULL AND length(close_note) BETWEEN 10 AND 500))
);
CREATE UNIQUE INDEX cash_shift_one_open ON cash_shifts(agent_id,site_id,currency) WHERE closed_at IS NULL;
ALTER TABLE agent_sales ADD COLUMN shift_id uuid REFERENCES cash_shifts(id);
CREATE INDEX agent_sales_shift_idx ON agent_sales(shift_id) WHERE shift_id IS NOT NULL;

CREATE FUNCTION preserve_cash_shift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.agent_id,NEW.site_id,NEW.currency,NEW.request_key,NEW.opening_minor,NEW.opened_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.agent_id,OLD.site_id,OLD.currency,OLD.request_key,OLD.opening_minor,OLD.opened_at)
 OR (OLD.closed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
  RAISE EXCEPTION 'Cash shift evidence is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER cash_shift_immutable BEFORE UPDATE ON cash_shifts FOR EACH ROW EXECUTE FUNCTION preserve_cash_shift();

CREATE FUNCTION validate_sale_shift() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE shift cash_shifts%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.shift_id IS DISTINCT FROM OLD.shift_id THEN RAISE EXCEPTION 'Sale shift is immutable' USING ERRCODE='23514'; END IF;
 ELSIF NEW.payment_method='cash' THEN
  SELECT * INTO shift FROM cash_shifts WHERE id=NEW.shift_id FOR UPDATE;
  IF NOT FOUND OR shift.closed_at IS NOT NULL OR shift.agent_id<>NEW.agent_id OR shift.site_id<>NEW.site_id OR shift.currency<>NEW.currency THEN
   RAISE EXCEPTION 'Cash sale requires its open agent shift' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER sale_shift_valid BEFORE INSERT OR UPDATE ON agent_sales FOR EACH ROW EXECUTE FUNCTION validate_sale_shift();
