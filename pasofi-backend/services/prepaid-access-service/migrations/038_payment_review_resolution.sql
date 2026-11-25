ALTER TABLE payment_reviews ADD COLUMN resolved_at timestamptz;

-- Resolution changes the queue without permitting edits to the original review.
CREATE FUNCTION preserve_payment_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.order_id,NEW.charge_id,NEW.reason,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.order_id,OLD.charge_id,OLD.reason,OLD.created_at) THEN
  RAISE EXCEPTION 'Payment review evidence is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER payment_review_evidence BEFORE UPDATE ON payment_reviews
 FOR EACH ROW EXECUTE FUNCTION preserve_payment_review();
