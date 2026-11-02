-- An administrator can initiate a separately verified authenticator recovery
-- for another staff account. Existing audit history remains append-only.
ALTER TABLE staff_audit_events DROP CONSTRAINT staff_audit_events_action_check;
ALTER TABLE staff_audit_events ADD CONSTRAINT staff_audit_events_action_check
  CHECK (action IN ('bootstrap','decision','revoke_sessions','mfa_recovery'));
