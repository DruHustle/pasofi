-- Periodic independent absence checks refresh a short-lived precondition, not
-- the operator's accounting decision. Resolution always checks their newest
-- values under the grant lock; repeated observations must not invalidate an
-- otherwise unchanged review form every time the worker polls the router.
CREATE OR REPLACE FUNCTION bump_grant_review_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.state,NEW.upload_high,NEW.download_high,NEW.charged_bytes,NEW.accounting_anomaly,NEW.last_accounting_at,NEW.stop_received_at,NEW.disconnect_requested_at)
 IS DISTINCT FROM ROW(OLD.state,OLD.upload_high,OLD.download_high,OLD.charged_bytes,OLD.accounting_anomaly,OLD.last_accounting_at,OLD.stop_received_at,OLD.disconnect_requested_at) THEN
  NEW.review_version:=OLD.review_version+1;
 ELSE NEW.review_version:=OLD.review_version;
 END IF;
 RETURN NEW;
END;
$$;
