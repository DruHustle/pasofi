CREATE TABLE customer_handoffs (
  code_hash bytea PRIMARY KEY CHECK (octet_length(code_hash) = 32),
  customer_id uuid NOT NULL REFERENCES customers(id),
  source_session_hash bytea NOT NULL REFERENCES customer_sessions(token_hash) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_handoffs_source_idx ON customer_handoffs(source_session_hash);
