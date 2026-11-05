-- Operator-managed configuration is separate from entitlement/RADIUS gates.
-- Snapshots contain only explicitly allowlisted, nonsecret router fields.
CREATE TABLE router_fleet_changes (
 id uuid PRIMARY KEY,
 nas_id uuid NOT NULL REFERENCES radius_nas(id),
 actor_id uuid NOT NULL,
 actor_version text NOT NULL CHECK (actor_version ~ '^[1-9][0-9]{0,18}$'),
 request_key uuid NOT NULL,
 request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 target_key text NOT NULL CHECK (target_key ~ '^[a-z][a-z0-9_-]{0,47}$'),
 target_kind text NOT NULL CHECK (target_kind IN ('identity','interface','wireless','wifi','hotspot-profile')),
 target_name text,
 target_record_id text,
 before_values jsonb NOT NULL CHECK (jsonb_typeof(before_values)='object'),
 after_values jsonb NOT NULL CHECK (jsonb_typeof(after_values)='object'),
 before_revision text NOT NULL CHECK (before_revision ~ '^[a-f0-9]{64}$'),
 after_revision text NOT NULL CHECK (after_revision ~ '^[a-f0-9]{64}$'),
 config_revision text NOT NULL CHECK (config_revision ~ '^[a-f0-9]{64}$'),
 status text NOT NULL CHECK (status IN ('prepared','applying','applied','unchanged','diverged','uncertain','expired','failed')),
 reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
 parent_change_id uuid REFERENCES router_fleet_changes(id),
 attempt_id uuid,
 reconcile_after timestamptz,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 applied_at timestamptz,
 UNIQUE (actor_id,request_key)
);
CREATE INDEX router_fleet_changes_history ON router_fleet_changes(nas_id,created_at DESC,id);
-- An ambiguous write keeps the device fenced until a settled observation.
CREATE UNIQUE INDEX router_fleet_one_active_write ON router_fleet_changes(nas_id) WHERE status IN ('applying','uncertain');
CREATE TABLE router_fleet_events (
 id uuid PRIMARY KEY,
 change_id uuid NOT NULL REFERENCES router_fleet_changes(id),
 nas_id uuid NOT NULL REFERENCES radius_nas(id),
 actor_id uuid NOT NULL,
 actor_version text NOT NULL CHECK (actor_version ~ '^[1-9][0-9]{0,18}$'),
 event_type text NOT NULL,
 status text NOT NULL,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX router_fleet_events_history ON router_fleet_events(change_id,created_at,id);
-- A runtime update may record execution progress, never rewrite its approved
-- plan, original actor, idempotency binding, expiry or rollback provenance.
CREATE FUNCTION router_fleet_preserve_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['status','attempt_id','reconcile_after','error_code','updated_at','applied_at'])
    IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','attempt_id','reconcile_after','error_code','updated_at','applied_at']) THEN
  RAISE EXCEPTION 'router_fleet_plan_immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER router_fleet_plan_immutable BEFORE UPDATE ON router_fleet_changes
 FOR EACH ROW EXECUTE FUNCTION router_fleet_preserve_plan();
