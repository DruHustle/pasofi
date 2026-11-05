CREATE TABLE invoice_jobs (
 id uuid PRIMARY KEY, event_id uuid NOT NULL UNIQUE REFERENCES event_inbox(id),
 invoice_id uuid NOT NULL UNIQUE,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','submitting','submitted','delivered','failed','unknown','canceled')),
 channel text CHECK(channel IN ('email','sms')),
 provider text CHECK(provider IN ('resend','sendai','mock')),
 provider_id text, attempted_at timestamptz, delivered_at timestamptz,
 lookup_attempts integer NOT NULL DEFAULT 0,
 lease_token uuid, lease_until timestamptz,
 next_at timestamptz NOT NULL DEFAULT now(), last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_jobs_schedule_idx ON invoice_jobs(next_at) WHERE state IN ('queued','submitting','submitted','unknown');
-- Demo evidence contains hashes only, never recipient addresses, SMS tokens or PDFs.
CREATE TABLE mock_invoice_sink (
 job_id uuid PRIMARY KEY REFERENCES invoice_jobs(id) ON DELETE CASCADE,
 channel text NOT NULL CHECK(channel IN ('email','sms')),
 content_hash bytea NOT NULL CHECK(octet_length(content_hash)=32),
 recipient_hash bytea NOT NULL CHECK(octet_length(recipient_hash)=32),
 created_at timestamptz NOT NULL DEFAULT now()
);
