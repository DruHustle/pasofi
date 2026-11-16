CREATE INDEX grant_reconciliation_presence_time
  ON grant_reconciliation_events (grant_id, observed_at)
  WHERE kind = 'present';
