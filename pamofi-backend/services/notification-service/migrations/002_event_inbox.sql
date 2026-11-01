CREATE TABLE event_inbox (
 id uuid PRIMARY KEY, producer text NOT NULL, event_type text NOT NULL, aggregate_id uuid NOT NULL,
 aggregate_version integer NOT NULL, payload_hash bytea NOT NULL CHECK(octet_length(payload_hash)=32),
 received_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(producer,event_type,aggregate_id,aggregate_version)
);
CREATE TABLE delivery_jobs (
 id uuid PRIMARY KEY, event_id uuid NOT NULL UNIQUE REFERENCES event_inbox(id),
 delivery_reference uuid NOT NULL, state text NOT NULL CHECK(state IN ('awaiting_delivery_details')),
 created_at timestamptz NOT NULL DEFAULT now()
);
