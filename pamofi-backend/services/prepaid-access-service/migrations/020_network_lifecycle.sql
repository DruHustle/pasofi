ALTER TABLE access_grants ADD COLUMN last_accounting_at timestamptz;
ALTER TABLE access_grants ADD COLUMN stop_received_at timestamptz;
ALTER TABLE access_grants ADD COLUMN stop_upload numeric(20,0);
ALTER TABLE access_grants ADD COLUMN stop_download numeric(20,0);
ALTER TABLE access_grants ADD COLUMN accounting_anomaly boolean NOT NULL DEFAULT false;
ALTER TABLE access_grants ADD COLUMN disconnect_requested_at timestamptz;
ALTER TABLE access_grants ADD COLUMN absent_verified_at timestamptz;
ALTER TABLE access_grants ADD COLUMN credential_fenced_at timestamptz;
ALTER TABLE access_grants ADD COLUMN reconcile_attempted_at timestamptz;
CREATE TABLE network_account_holds (
 customer_id uuid PRIMARY KEY,
 grant_id uuid NOT NULL REFERENCES access_grants(id),
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE grant_reconciliation_events (
 id uuid PRIMARY KEY,
 grant_id uuid NOT NULL REFERENCES access_grants(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('absent','present','closed','late_usage','nas_restart','operator_resolution')),
 observed_at timestamptz NOT NULL,
 detail jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX grants_reconcile_pending ON access_grants(reconcile_attempted_at,issued_at) WHERE state <> 'closed';
