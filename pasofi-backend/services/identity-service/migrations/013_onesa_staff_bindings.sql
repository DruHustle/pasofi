-- An owner explicitly links a verified Portal subject to an existing staff record.
-- Each binding has an independent ID so revoking and recreating it cannot revive a session.
CREATE TABLE staff_onesa_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer text NOT NULL,
  subject uuid NOT NULL,
  staff_id uuid NOT NULL UNIQUE REFERENCES staff_users(id) ON DELETE CASCADE,
  UNIQUE (issuer, subject)
);
-- An existing session pins a binding ID. Changing its subject or local staff ID
-- would redirect that session, so a reassignment must delete the old binding.
CREATE FUNCTION reject_staff_onesa_binding_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Replace a staff identity binding by deleting and inserting it' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER staff_onesa_binding_immutable BEFORE UPDATE ON staff_onesa_bindings
  FOR EACH ROW EXECUTE FUNCTION reject_staff_onesa_binding_update();
ALTER TABLE staff_onesa_sessions
  ADD COLUMN binding_id uuid REFERENCES staff_onesa_bindings(id) ON DELETE CASCADE,
  ADD COLUMN staff_version integer,
  ADD CHECK ((binding_id IS NULL) = (staff_version IS NULL));
