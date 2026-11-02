ALTER TABLE delivery_jobs ADD COLUMN lease_token uuid;
ALTER TABLE delivery_jobs ADD COLUMN lease_until timestamptz;
ALTER TABLE delivery_jobs ADD COLUMN lookup_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE delivery_jobs ADD COLUMN next_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE delivery_jobs ADD COLUMN last_error text;
CREATE INDEX delivery_jobs_schedule_idx ON delivery_jobs(next_at) WHERE state IN ('awaiting_delivery_details','ready','submitted','unknown');
CREATE TABLE delivery_resend_requests (
 id uuid PRIMARY KEY,delivery_reference uuid NOT NULL,actor_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 500),
 job_id uuid NOT NULL UNIQUE REFERENCES delivery_jobs(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mock_sms_sink (
 id uuid PRIMARY KEY,job_id uuid NOT NULL UNIQUE REFERENCES delivery_jobs(id) ON DELETE CASCADE,
 message_hash bytea NOT NULL CHECK(octet_length(message_hash)=32),recipient_last4 char(4) NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
