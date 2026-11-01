CREATE TABLE customers (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE customer_sessions (
  token_hash bytea PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(token_hash) = 32)
);
CREATE INDEX customer_sessions_customer_id_idx ON customer_sessions(customer_id);
