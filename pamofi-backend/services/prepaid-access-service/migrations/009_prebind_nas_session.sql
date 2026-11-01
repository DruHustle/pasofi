-- The NAS session is bound before an Access-Accept can be constructed.
-- Legacy grants with no session stay blocked and require reconciliation.
ALTER TABLE access_grants ADD COLUMN accounting_started_at timestamptz;
UPDATE access_grants AS g SET accounting_started_at = COALESCE(e.activated_at, g.issued_at)
FROM purchase_entitlements AS e
WHERE g.entitlement_id=e.id AND g.accounting_session_id IS NOT NULL
  AND g.state IN ('active','uncertain') AND e.activated_at IS NOT NULL;
CREATE UNIQUE INDEX one_live_grant_per_nas_session ON access_grants(nas_id, accounting_session_id)
WHERE state <> 'closed' AND nas_id IS NOT NULL AND accounting_session_id IS NOT NULL;
