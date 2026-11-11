-- Federated administrators have no local password, role grant or recovery record.
CREATE TABLE staff_onesa_flows (
  state_hash bytea PRIMARY KEY CHECK (octet_length(state_hash)=32),
  browser_hash bytea NOT NULL CHECK (octet_length(browser_hash)=32),
  verifier text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes'
);
CREATE INDEX staff_onesa_flows_expiry ON staff_onesa_flows(expires_at);
CREATE TABLE staff_onesa_sessions (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash)=32),
  issuer text NOT NULL,
  subject uuid NOT NULL,
  access_ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_onesa_sessions_expiry ON staff_onesa_sessions(expires_at);
