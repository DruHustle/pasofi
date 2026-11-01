CREATE TABLE payment_reconciliation_jobs (
 attempt_id uuid PRIMARY KEY REFERENCES provider_payment_attempts(id) ON DELETE CASCADE,
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','idle','dead')),
 requested_version bigint NOT NULL DEFAULT 1 CHECK (requested_version > 0),
 lease_version bigint,
 lease_token uuid,
 lease_until timestamptz,
 due_at timestamptz NOT NULL DEFAULT now(),
 attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
 last_result text CHECK (last_result IN ('fulfilled','pending','unable_to_verify','failed','reversed','pending_review','previously_verified','error')),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((state='leased') = (lease_token IS NOT NULL AND lease_until IS NOT NULL AND lease_version IS NOT NULL)),
 CHECK (state='leased' OR (lease_token IS NULL AND lease_until IS NULL AND lease_version IS NULL))
);
CREATE INDEX payment_reconciliation_due ON payment_reconciliation_jobs(due_at) WHERE state IN ('pending','leased');
