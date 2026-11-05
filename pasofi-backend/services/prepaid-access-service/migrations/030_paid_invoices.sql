-- Ordinary paid invoices are immutable commercial payment records. They are
-- not fiscal-device/FDMS tax invoices. Source records and refund history remain
-- separate; this migration does not backfill unrecorded historical payments.
CREATE SEQUENCE paid_invoice_number_seq AS bigint;
CREATE TABLE paid_invoices (
 id uuid PRIMARY KEY,
 number text NOT NULL UNIQUE CHECK(number ~ '^PFI-[0-9]+$'),
 source_type text NOT NULL CHECK(source_type IN ('cash','digital')),
 sale_id uuid UNIQUE REFERENCES agent_sales(id),
 order_id uuid UNIQUE REFERENCES purchase_orders(id),
 customer_id uuid,
 agent_id uuid,
 site_id uuid,
 issued_at timestamptz NOT NULL,
 paid_at timestamptz NOT NULL,
 currency char(3) NOT NULL,
 total_minor integer NOT NULL CHECK(total_minor>0),
 simulation boolean NOT NULL,
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 pdf_bytes bytea NOT NULL CHECK(octet_length(pdf_bytes) BETWEEN 100 AND 1048576),
 pdf_sha256 bytea NOT NULL CHECK(octet_length(pdf_sha256)=32),
 CHECK((source_type='cash' AND sale_id IS NOT NULL AND order_id IS NULL AND agent_id IS NOT NULL AND site_id IS NOT NULL)
    OR (source_type='digital' AND order_id IS NOT NULL AND sale_id IS NULL AND customer_id IS NOT NULL AND agent_id IS NULL))
);
CREATE INDEX paid_invoices_customer ON paid_invoices(customer_id,issued_at DESC,id);
CREATE INDEX paid_invoices_agent ON paid_invoices(agent_id,site_id,issued_at DESC,id);
CREATE FUNCTION preserve_paid_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'Paid invoice snapshots and PDFs are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER paid_invoice_immutable BEFORE UPDATE ON paid_invoices FOR EACH ROW EXECUTE FUNCTION preserve_paid_invoice();
-- Runtime grants are SELECT/INSERT only. Owner-only disposable-test cleanup
-- deletes these children explicitly before their referenced source records.
CREATE TABLE invoice_delivery_intents (
 order_id uuid PRIMARY KEY REFERENCES purchase_orders(id),
 channel text NOT NULL CHECK(channel IN ('download','email','sms')),
 request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32),
 key_id text,
 payload_cipher bytea,
 payload_iv bytea,
 payload_tag bytea,
 CHECK((channel='download' AND key_id IS NULL AND payload_cipher IS NULL AND payload_iv IS NULL AND payload_tag IS NULL)
    OR (channel IN ('email','sms') AND key_id IS NOT NULL AND payload_cipher IS NOT NULL AND payload_iv IS NOT NULL AND payload_tag IS NOT NULL AND octet_length(payload_iv)=12 AND octet_length(payload_tag)=16))
);
CREATE TABLE invoice_deliveries (
 invoice_id uuid PRIMARY KEY REFERENCES paid_invoices(id),
 channel text NOT NULL CHECK(channel IN ('download','email','sms')),
 key_id text,
 payload_cipher bytea,
 payload_iv bytea,
 payload_tag bytea,
 download_token_hash bytea UNIQUE,
 token_expires_at timestamptz,
 CHECK((channel='download' AND key_id IS NULL AND payload_cipher IS NULL AND payload_iv IS NULL AND payload_tag IS NULL)
    OR (channel IN ('email','sms') AND key_id IS NOT NULL AND payload_cipher IS NOT NULL AND payload_iv IS NOT NULL AND payload_tag IS NOT NULL AND octet_length(payload_iv)=12 AND octet_length(payload_tag)=16)),
 CHECK((channel='sms' AND download_token_hash IS NOT NULL AND octet_length(download_token_hash)=32 AND token_expires_at IS NOT NULL)
    OR (channel<>'sms' AND download_token_hash IS NULL AND token_expires_at IS NULL))
);
