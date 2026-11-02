ALTER TABLE access_grants ADD COLUMN review_version bigint NOT NULL DEFAULT 1 CHECK(review_version>0);
CREATE FUNCTION bump_grant_review_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.state,NEW.upload_high,NEW.download_high,NEW.charged_bytes,NEW.accounting_anomaly,NEW.absent_verified_at,NEW.credential_fenced_at,NEW.last_accounting_at,NEW.stop_received_at,NEW.disconnect_requested_at)
 IS DISTINCT FROM ROW(OLD.state,OLD.upload_high,OLD.download_high,OLD.charged_bytes,OLD.accounting_anomaly,OLD.absent_verified_at,OLD.credential_fenced_at,OLD.last_accounting_at,OLD.stop_received_at,OLD.disconnect_requested_at) THEN
  NEW.review_version:=OLD.review_version+1;
 ELSE NEW.review_version:=OLD.review_version;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER access_grants_review_version BEFORE UPDATE ON access_grants FOR EACH ROW EXECUTE FUNCTION bump_grant_review_version();
CREATE TABLE network_operator_resolutions (
 id uuid PRIMARY KEY,actor_id uuid NOT NULL,request_key uuid NOT NULL,grant_id uuid NOT NULL REFERENCES access_grants(id),
 request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32),previous_version bigint NOT NULL,resolved_version bigint NOT NULL,
 final_upload numeric(20,0) NOT NULL,final_download numeric(20,0) NOT NULL,
 additional_bytes bigint NOT NULL CHECK(additional_bytes>=0),reason text NOT NULL,evidence_reference text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(actor_id,request_key)
);
