-- Agent attribution uses the existing customer-owned digital payment ledger.
-- Available stock is reserved before contacting Stripe, never at link creation.
CREATE TABLE agent_checkouts (
 id uuid PRIMARY KEY,
 agent_id uuid NOT NULL,
 agent_version bigint NOT NULL CHECK(agent_version>0),
 site_id uuid NOT NULL REFERENCES sales_locations(id),
 bundle_id text NOT NULL REFERENCES bundle_versions(id),
 request_key uuid NOT NULL,
 request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32),
 token_hash bytea NOT NULL UNIQUE CHECK(octet_length(token_hash)=32),
 key_id text NOT NULL,
 token_cipher bytea NOT NULL,
 token_iv bytea NOT NULL CHECK(octet_length(token_iv)=12),
 token_tag bytea NOT NULL CHECK(octet_length(token_tag)=16),
 site_name text NOT NULL,
 price_minor integer NOT NULL CHECK(price_minor>0),
 currency char(3) NOT NULL,
 byte_limit bigint NOT NULL CHECK(byte_limit>0),
 validity_seconds integer NOT NULL CHECK(validity_seconds>0),
 commission_bps integer NOT NULL CHECK(commission_bps BETWEEN 0 AND 10000),
 commission_minor integer NOT NULL CHECK(commission_minor BETWEEN 0 AND price_minor),
 simulation boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 order_id uuid UNIQUE REFERENCES purchase_orders(id),
 claimed_at timestamptz,
 stock_state text NOT NULL DEFAULT 'none' CHECK(stock_state IN ('none','reserved','consumed','released')),
 reserved_at timestamptz,
 consumed_at timestamptz,
 released_at timestamptz,
 fulfilled_charge_id uuid UNIQUE REFERENCES verified_charges(id),
 commission_review boolean NOT NULL DEFAULT false,
 closed_at timestamptz,
 UNIQUE(agent_id,request_key),
 CHECK(expires_at>created_at),
 CHECK((order_id IS NULL)=(claimed_at IS NULL)),
 CHECK(
   (stock_state='none' AND reserved_at IS NULL AND consumed_at IS NULL AND released_at IS NULL AND fulfilled_charge_id IS NULL)
   OR (stock_state='reserved' AND order_id IS NOT NULL AND reserved_at IS NOT NULL AND consumed_at IS NULL AND released_at IS NULL AND fulfilled_charge_id IS NULL AND closed_at IS NULL)
   OR (stock_state='consumed' AND order_id IS NOT NULL AND reserved_at IS NOT NULL AND consumed_at IS NOT NULL AND released_at IS NULL AND fulfilled_charge_id IS NOT NULL AND closed_at IS NULL)
   OR (stock_state='released' AND order_id IS NOT NULL AND reserved_at IS NOT NULL AND consumed_at IS NULL AND released_at IS NOT NULL AND fulfilled_charge_id IS NULL AND closed_at IS NOT NULL)
 )
);
CREATE INDEX agent_checkouts_agent_recent ON agent_checkouts(agent_id,created_at DESC,id);
CREATE INDEX agent_checkouts_site_recent ON agent_checkouts(site_id,created_at DESC,id);

CREATE FUNCTION preserve_agent_checkout() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE purchase purchase_orders%ROWTYPE;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.order_id IS NOT NULL OR NEW.stock_state<>'none' OR NEW.commission_review OR NEW.closed_at IS NOT NULL THEN
   RAISE EXCEPTION 'agent checkout must begin unclaimed without stock or payment evidence'
    USING ERRCODE='23514',CONSTRAINT='agent_checkout_initial_state';
  END IF;
  RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['order_id','claimed_at','stock_state','reserved_at','consumed_at','released_at','fulfilled_charge_id','commission_review','closed_at'])
 IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['order_id','claimed_at','stock_state','reserved_at','consumed_at','released_at','fulfilled_charge_id','commission_review','closed_at'])
 OR (OLD.order_id IS NOT NULL AND ROW(NEW.order_id,NEW.claimed_at) IS DISTINCT FROM ROW(OLD.order_id,OLD.claimed_at))
 OR (OLD.reserved_at IS NOT NULL AND NEW.reserved_at IS DISTINCT FROM OLD.reserved_at)
 OR (OLD.fulfilled_charge_id IS NOT NULL AND ROW(NEW.fulfilled_charge_id,NEW.consumed_at) IS DISTINCT FROM ROW(OLD.fulfilled_charge_id,OLD.consumed_at))
 OR (OLD.closed_at IS NOT NULL AND ROW(NEW.closed_at,NEW.released_at) IS DISTINCT FROM ROW(OLD.closed_at,OLD.released_at))
 OR (OLD.commission_review AND NOT NEW.commission_review)
 OR NOT (NEW.stock_state=OLD.stock_state OR (OLD.stock_state='none' AND NEW.stock_state='reserved') OR (OLD.stock_state='reserved' AND NEW.stock_state IN ('consumed','released')))
 THEN
  RAISE EXCEPTION 'agent checkout binding and stock history are immutable'
   USING ERRCODE='23514',CONSTRAINT='immutable_agent_checkout';
 END IF;
 IF OLD.order_id IS NULL AND NEW.order_id IS NOT NULL THEN
  SELECT * INTO purchase FROM purchase_orders WHERE id=NEW.order_id FOR UPDATE;
  IF NOT FOUND OR purchase.purchase_mode<>'checkout' OR purchase.status<>'awaiting_payment'
   OR purchase.expired_unused_at IS NOT NULL OR purchase.created_at<NEW.created_at
   OR ROW(purchase.bundle_id,purchase.price_minor,purchase.currency,purchase.byte_limit,purchase.validity_seconds)
      IS DISTINCT FROM ROW(NEW.bundle_id,NEW.price_minor,NEW.currency,NEW.byte_limit,NEW.validity_seconds)
   OR EXISTS(SELECT 1 FROM provider_payment_attempts WHERE order_id=NEW.order_id)
   OR EXISTS(SELECT 1 FROM verified_charges WHERE order_id=NEW.order_id)
   OR EXISTS(SELECT 1 FROM purchase_entitlements WHERE order_id=NEW.order_id)
  THEN
   RAISE EXCEPTION 'agent attribution must bind before payment starts'
    USING ERRCODE='23514',CONSTRAINT='agent_checkout_order_binding';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER agent_checkout_immutable BEFORE INSERT OR UPDATE ON agent_checkouts
 FOR EACH ROW EXECUTE FUNCTION preserve_agent_checkout();

-- Older processes must not create an attempt after a released reservation,
-- change the attributed site/customer, or bypass the shared stock reservation.
CREATE FUNCTION guard_agent_checkout_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE purchase purchase_orders%ROWTYPE; attribution agent_checkouts%ROWTYPE;
BEGIN
 SELECT * INTO purchase FROM purchase_orders WHERE id=NEW.order_id FOR UPDATE;
 SELECT * INTO attribution FROM agent_checkouts WHERE order_id=NEW.order_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF attribution.closed_at IS NOT NULL OR attribution.stock_state<>'reserved'
 OR purchase.customer_id<>NEW.customer_id OR attribution.site_id<>NEW.site_id
 OR purchase.purchase_mode<>'checkout' OR purchase.status<>'awaiting_payment'
 OR ROW(purchase.bundle_id,purchase.price_minor,purchase.currency,purchase.byte_limit,purchase.validity_seconds)
    IS DISTINCT FROM ROW(attribution.bundle_id,attribution.price_minor,attribution.currency,attribution.byte_limit,attribution.validity_seconds)
 OR NEW.method_code<>'STRIPE_CARD'
 OR NEW.provider<>(CASE WHEN attribution.simulation THEN 'stripe_test' ELSE 'stripe' END)
 THEN
  RAISE EXCEPTION 'agent checkout does not accept this payment attempt'
   USING ERRCODE='23514',CONSTRAINT='agent_checkout_attempt_binding';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER agent_checkout_attempt_binding BEFORE INSERT OR UPDATE OF order_id,customer_id,site_id,method_code,provider ON provider_payment_attempts
 FOR EACH ROW EXECUTE FUNCTION guard_agent_checkout_attempt();
