-- Reset material is high-entropy, stored only as a hash and bound to the
-- staff version; existing MFA is deliberately not changed by password reset.
ALTER TABLE staff_users ADD COLUMN password_reset_requested_at timestamptz;
CREATE TABLE staff_password_reset_tokens (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  staff_id uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  staff_version integer NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_password_reset_tokens_staff_idx ON staff_password_reset_tokens(staff_id, expires_at);
ALTER TABLE staff_audit_events DROP CONSTRAINT staff_audit_events_action_check;
ALTER TABLE staff_audit_events ADD CONSTRAINT staff_audit_events_action_check
  CHECK (action IN ('bootstrap','decision','revoke_sessions','mfa_recovery','password_reset'));
