-- Portal handoff credentials never reference a guest session or appear in URLs.
CREATE TABLE customer_onesa_handoffs (
  code_hash bytea PRIMARY KEY CHECK (octet_length(code_hash)=32),
  customer_id uuid NOT NULL REFERENCES customers(id),
  source_session_hash bytea NOT NULL REFERENCES customer_onesa_sessions(token_hash),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_onesa_handoffs_source ON customer_onesa_handoffs(source_session_hash);
