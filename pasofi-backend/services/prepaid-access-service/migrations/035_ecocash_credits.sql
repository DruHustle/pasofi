-- An incoming EcoCash transfer has its own funding record. It is never an
-- agent cash sale and creates no entitlement until its voucher is redeemed.
CREATE TABLE ecocash_credits (
  id uuid PRIMARY KEY,
  environment text NOT NULL CHECK (environment = 'simulation'),
  transaction_id text NOT NULL CHECK (transaction_id ~ '^[A-Za-z0-9._-]{1,128}$'),
  merchant_code text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  paid_at timestamptz NOT NULL,
  phone_key_id text,
  phone_iv bytea CHECK (octet_length(phone_iv) = 12),
  phone_cipher bytea,
  phone_tag bytea CHECK (octet_length(phone_tag) = 16),
  bundle_id text REFERENCES bundle_versions(id),
  byte_limit bigint CHECK (byte_limit > 0),
  validity_seconds integer CHECK (validity_seconds > 0),
  start_by timestamptz,
  state text NOT NULL CHECK (state IN ('issued','review','reversed')),
  reason text,
  reversed_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment, merchant_code, transaction_id),
  CHECK (num_nonnulls(phone_key_id,phone_iv,phone_cipher,phone_tag) IN (0,4)),
  CHECK (num_nonnulls(bundle_id,byte_limit,validity_seconds,start_by) IN (0,4)),
  CHECK (state <> 'issued' OR (bundle_id IS NOT NULL AND phone_key_id IS NOT NULL AND reversed_at IS NULL)),
  CHECK ((state = 'review') = (reason IS NOT NULL)),
  CHECK (state <> 'reversed' OR reversed_at IS NOT NULL)
);
ALTER TABLE issued_vouchers ALTER COLUMN sale_id DROP NOT NULL;
ALTER TABLE issued_vouchers ADD COLUMN ecocash_credit_id uuid UNIQUE REFERENCES ecocash_credits(id);
ALTER TABLE issued_vouchers ADD CONSTRAINT voucher_one_funding_source
  CHECK (num_nonnulls(sale_id,ecocash_credit_id) = 1);
