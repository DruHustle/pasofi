ALTER TABLE event_outbox ADD COLUMN status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','dead'));
ALTER TABLE event_outbox ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0);
ALTER TABLE event_outbox ADD COLUMN next_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE event_outbox ADD COLUMN lease_until timestamptz;
ALTER TABLE event_outbox ADD COLUMN lease_token uuid;
ALTER TABLE event_outbox ADD COLUMN last_error text;
CREATE UNIQUE INDEX event_outbox_version_idx ON event_outbox(event_type,aggregate_id,aggregate_version);
CREATE INDEX event_outbox_dispatch_idx ON event_outbox(next_at) WHERE status='pending';
CREATE TABLE outbox_replay_audit (
 id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES event_outbox(id), actor_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 500), created_at timestamptz NOT NULL DEFAULT now()
);
