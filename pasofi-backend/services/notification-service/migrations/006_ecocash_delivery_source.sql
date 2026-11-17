ALTER TABLE delivery_jobs
  ADD COLUMN source_kind text NOT NULL DEFAULT 'agent_sale'
  CHECK (source_kind IN ('agent_sale', 'ecocash_demo_credit'));
