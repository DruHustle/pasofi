-- Customer identities are bound to the verified issuer and subject, never email.
CREATE TABLE customer_onesa_identities (
  issuer text NOT NULL,
  subject uuid NOT NULL,
  customer_id uuid NOT NULL UNIQUE REFERENCES customers(id),
  PRIMARY KEY (issuer, subject)
);
CREATE TABLE customer_onesa_flows (
  state_hash bytea PRIMARY KEY CHECK (octet_length(state_hash)=32),
  browser_hash bytea NOT NULL CHECK (octet_length(browser_hash)=32),
  verifier text NOT NULL,
  nonce text NOT NULL,
  return_to text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes'
);
CREATE INDEX customer_onesa_flows_expiry ON customer_onesa_flows(expires_at);
CREATE TABLE customer_onesa_sessions (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash)=32),
  customer_id uuid NOT NULL REFERENCES customers(id),
  access_ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX customer_onesa_sessions_expiry ON customer_onesa_sessions(expires_at);
