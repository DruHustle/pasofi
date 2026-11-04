CREATE TABLE cash_refunds (
 id uuid PRIMARY KEY,
 sale_id uuid NOT NULL UNIQUE REFERENCES agent_sales(id),
 requested_by uuid NOT NULL,
 request_key uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 500),
 requested_at timestamptz NOT NULL DEFAULT now(),
 state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','approved','rejected','paying','paid')),
 decided_by uuid,
 decision_key uuid,
 decision_note text,
 decided_at timestamptz,
 reserved_by uuid,
 reserve_key uuid,
 reserved_at timestamptz,
 paid_by uuid,
 payout_key uuid,
 payout_shift_id uuid REFERENCES cash_shifts(id),
 paid_at timestamptz,
 UNIQUE(requested_by,request_key),
 CHECK ((state='requested' AND decided_by IS NULL AND decision_key IS NULL AND decision_note IS NULL AND decided_at IS NULL)
 OR (state<>'requested' AND decided_by IS NOT NULL AND decided_by<>requested_by AND decision_key IS NOT NULL AND decision_note IS NOT NULL AND length(decision_note) BETWEEN 10 AND 500 AND decided_at IS NOT NULL)),
 CHECK ((state NOT IN ('paying','paid') AND reserved_by IS NULL AND reserve_key IS NULL AND reserved_at IS NULL AND payout_shift_id IS NULL)
 OR (state IN ('paying','paid') AND reserved_by IS NOT NULL AND reserve_key IS NOT NULL AND reserved_at IS NOT NULL AND payout_shift_id IS NOT NULL)),
 CHECK ((state<>'paid' AND paid_by IS NULL AND payout_key IS NULL AND paid_at IS NULL)
 OR (state='paid' AND paid_by IS NOT NULL AND paid_by=reserved_by AND payout_key IS NOT NULL AND paid_at IS NOT NULL))
);
CREATE INDEX cash_refunds_payout_shift ON cash_refunds(payout_shift_id) WHERE state='paid';
-- Hashes link canonical event payloads. Runtime credentials can append, never
-- update or delete events. Exported heads can be compared with retained backups.
CREATE TABLE cash_refund_events (
 refund_id uuid NOT NULL REFERENCES cash_refunds(id),
 sequence integer NOT NULL CHECK(sequence>0),
 payload text NOT NULL CHECK(jsonb_typeof(payload::jsonb)='object'),
 previous_hash text NOT NULL CHECK(previous_hash ~ '^[a-f0-9]{64}$'),
 entry_hash text NOT NULL CHECK(entry_hash ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(refund_id,sequence)
);
CREATE FUNCTION preserve_cash_refund() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.sale_id,NEW.requested_by,NEW.request_key,NEW.reason,NEW.requested_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.sale_id,OLD.requested_by,OLD.request_key,OLD.reason,OLD.requested_at)
 OR (NEW.state<>OLD.state AND NOT ((OLD.state='requested' AND NEW.state IN ('approved','rejected')) OR (OLD.state='approved' AND NEW.state='paying') OR (OLD.state='paying' AND NEW.state='paid')))
 OR (OLD.decided_at IS NOT NULL AND ROW(NEW.decided_by,NEW.decision_key,NEW.decision_note,NEW.decided_at) IS DISTINCT FROM ROW(OLD.decided_by,OLD.decision_key,OLD.decision_note,OLD.decided_at))
 OR (OLD.reserved_at IS NOT NULL AND ROW(NEW.reserved_by,NEW.reserve_key,NEW.reserved_at,NEW.payout_shift_id) IS DISTINCT FROM ROW(OLD.reserved_by,OLD.reserve_key,OLD.reserved_at,OLD.payout_shift_id))
 OR (OLD.state IN ('rejected','paid') AND NEW IS DISTINCT FROM OLD) THEN
  RAISE EXCEPTION 'Refund evidence and decisions are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER cash_refund_immutable BEFORE UPDATE ON cash_refunds FOR EACH ROW EXECUTE FUNCTION preserve_cash_refund();
