-- Existing sales have no recorded tender evidence. Do not invent a historical
-- cash confirmation when upgrading them.
ALTER TABLE agent_sales ADD COLUMN payment_method text;
ALTER TABLE agent_sales ADD COLUMN cash_received_minor integer;
ALTER TABLE agent_sales ADD COLUMN cash_confirmed_at timestamptz;
ALTER TABLE agent_sales ADD CONSTRAINT sale_cash_attestation_complete CHECK (
 (payment_method IS NULL AND cash_received_minor IS NULL AND cash_confirmed_at IS NULL)
 OR
 (payment_method IS NOT NULL AND payment_method='cash' AND cash_received_minor IS NOT NULL AND cash_received_minor=price_minor AND cash_confirmed_at IS NOT NULL)
);

CREATE FUNCTION protect_sale_cash_attestation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.payment_method,NEW.cash_received_minor,NEW.cash_confirmed_at,NEW.agent_id,NEW.price_minor,NEW.currency)
 IS DISTINCT FROM ROW(OLD.payment_method,OLD.cash_received_minor,OLD.cash_confirmed_at,OLD.agent_id,OLD.price_minor,OLD.currency) THEN
  RAISE EXCEPTION 'sale payment evidence is immutable'
   USING ERRCODE='23514',CONSTRAINT='immutable_sale_cash_attestation';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_sale_cash_attestation BEFORE UPDATE ON agent_sales
 FOR EACH ROW EXECUTE FUNCTION protect_sale_cash_attestation();
