-- An owner explicitly links a verified Portal subject to an existing staff record.
-- Each binding has an independent ID so revoking and recreating it cannot revive a session.
CREATE TABLE staff_onesa_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer text NOT NULL,
  subject uuid NOT NULL,
  staff_id uuid NOT NULL UNIQUE REFERENCES staff_users(id) ON DELETE CASCADE,
  UNIQUE (issuer, subject)
);
ALTER TABLE staff_onesa_sessions
  ADD COLUMN binding_id uuid REFERENCES staff_onesa_bindings(id) ON DELETE CASCADE,
  ADD COLUMN staff_version integer,
  ADD CHECK ((binding_id IS NULL) = (staff_version IS NULL));
