CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY, customer_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  bundle_id text NOT NULL, price_minor integer NOT NULL CHECK (price_minor > 0), currency char(3) NOT NULL,
  byte_limit bigint NOT NULL CHECK (byte_limit > 0), validity_seconds integer NOT NULL CHECK (validity_seconds > 0),
  status text NOT NULL CHECK (status IN ('awaiting_payment','payment_confirmed')),
  created_at timestamptz NOT NULL DEFAULT now(), quote_expires_at timestamptz NOT NULL,
  UNIQUE (customer_id, idempotency_key)
);
CREATE TABLE purchase_entitlements (
  id uuid PRIMARY KEY, order_id uuid NOT NULL UNIQUE REFERENCES purchase_orders(id), customer_id uuid NOT NULL,
  bundle_id text NOT NULL, byte_limit bigint NOT NULL CHECK (byte_limit > 0), validity_seconds integer NOT NULL CHECK (validity_seconds > 0),
  purchased_at timestamptz NOT NULL DEFAULT now(), start_by timestamptz NOT NULL,
  activated_at timestamptz, consumed_bytes bigint NOT NULL DEFAULT 0 CHECK (consumed_bytes >= 0 AND consumed_bytes <= byte_limit)
);
CREATE INDEX purchase_orders_customer_idx ON purchase_orders (customer_id, created_at DESC);
CREATE INDEX purchase_entitlements_customer_idx ON purchase_entitlements (customer_id, purchased_at, id);
CREATE TABLE mock_payment_records (
  id uuid PRIMARY KEY, order_id uuid NOT NULL UNIQUE REFERENCES purchase_orders(id),
  amount_minor integer NOT NULL, currency char(3) NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
