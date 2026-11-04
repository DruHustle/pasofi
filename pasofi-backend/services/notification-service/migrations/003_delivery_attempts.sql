ALTER TABLE delivery_jobs DROP CONSTRAINT delivery_jobs_state_check;
ALTER TABLE delivery_jobs ADD CONSTRAINT delivery_jobs_state_check CHECK(state IN ('awaiting_delivery_details','ready','submitting','submitted','unknown','failed','delivered','canceled'));
CREATE TABLE delivery_attempts (
 id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES delivery_jobs(id), attempt_number integer NOT NULL CHECK(attempt_number > 0),
 state text NOT NULL CHECK(state IN ('submitting','submitted','unknown','failed','delivered')),
 provider_id uuid UNIQUE, provider_status text, charge_amount numeric(30,0), charge_scale smallint, charge_currency char(3),
 delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((charge_amount IS NULL AND charge_scale IS NULL AND charge_currency IS NULL) OR (charge_amount IS NOT NULL AND charge_scale IS NOT NULL AND charge_currency IS NOT NULL AND charge_amount >= 0 AND charge_scale=4)),
 CHECK (state <> 'submitted' OR provider_id IS NOT NULL),
 CHECK (state <> 'delivered' OR delivered_at IS NOT NULL),
 UNIQUE(job_id,attempt_number)
);
