ALTER TABLE cash_shifts ADD COLUMN refund_only boolean NOT NULL DEFAULT false;

CREATE FUNCTION protect_cash_shift_purpose() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.refund_only IS DISTINCT FROM OLD.refund_only THEN
  RAISE EXCEPTION 'Cash shift purpose is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER cash_shift_purpose_immutable BEFORE UPDATE OF refund_only ON cash_shifts
 FOR EACH ROW EXECUTE FUNCTION protect_cash_shift_purpose();

-- Preserve the restriction for mixed-version runtimes during a rolling update.
CREATE FUNCTION reject_refund_shift_sale() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM cash_shifts WHERE id=NEW.shift_id AND refund_only) THEN
  RAISE EXCEPTION 'A refund-only shift cannot accept cash sales' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER sale_shift_purpose BEFORE INSERT ON agent_sales
 FOR EACH ROW WHEN (NEW.shift_id IS NOT NULL) EXECUTE FUNCTION reject_refund_shift_sale();
