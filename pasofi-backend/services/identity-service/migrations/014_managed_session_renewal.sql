-- A handoff can share a provider renewal grant without copying a rotating token.
CREATE TABLE onesa_session_renewals (
  id uuid PRIMARY KEY,
  subject uuid NOT NULL,
  provider_subject text NOT NULL,
  client_id text NOT NULL,
  access_ciphertext text NOT NULL,
  refresh_ciphertext text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  staff_mfa_at timestamptz
);
CREATE INDEX onesa_session_renewals_expiry ON onesa_session_renewals(expires_at);
ALTER TABLE customer_onesa_sessions ADD COLUMN renewal_id uuid REFERENCES onesa_session_renewals(id) ON DELETE SET NULL;
ALTER TABLE staff_onesa_sessions ADD COLUMN renewal_id uuid REFERENCES onesa_session_renewals(id) ON DELETE SET NULL;
CREATE INDEX customer_onesa_sessions_renewal ON customer_onesa_sessions(renewal_id);
CREATE INDEX staff_onesa_sessions_renewal ON staff_onesa_sessions(renewal_id);
ALTER TABLE customer_onesa_flows ADD COLUMN guest_session_hash bytea CHECK (octet_length(guest_session_hash)=32);
