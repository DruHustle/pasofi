ALTER TABLE purchase_orders ADD COLUMN expired_unused_at timestamptz;
ALTER TABLE purchase_orders ADD CONSTRAINT unused_quote_fence_state
 CHECK(expired_unused_at IS NULL OR (purchase_mode='checkout' AND status='awaiting_payment'));

-- All initiation paths, including an older process during an upgrade, must
-- acquire the same order lock and respect the durable unused-quote fence.
CREATE FUNCTION reject_fenced_payment_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fenced_at timestamptz;
BEGIN
 SELECT expired_unused_at INTO fenced_at FROM purchase_orders WHERE id=NEW.order_id FOR UPDATE;
 IF fenced_at IS NOT NULL THEN
  RAISE EXCEPTION 'order no longer accepts payment attempts'
   USING ERRCODE='23514',CONSTRAINT='no_payment_attempt_for_expired_unused_order';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER provider_attempt_quote_fence BEFORE INSERT OR UPDATE OF order_id ON provider_payment_attempts
 FOR EACH ROW EXECUTE FUNCTION reject_fenced_payment_attempt();
CREATE INDEX provider_attempts_order_history ON provider_payment_attempts(order_id,created_at DESC);
