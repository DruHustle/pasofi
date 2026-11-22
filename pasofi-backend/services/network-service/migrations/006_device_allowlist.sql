-- Approved devices skip the HotSpot captive portal at every configured site
-- router. This table is the desired list; routers hold tagged ip-bindings.
CREATE TABLE device_allowlist_entries (
 id uuid PRIMARY KEY,
 mac_address text NOT NULL CHECK (mac_address ~ '^[0-9A-F]{2}(:[0-9A-F]{2}){5}$'),
 label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
 created_by uuid NOT NULL,
 created_by_version text NOT NULL CHECK (created_by_version ~ '^[1-9][0-9]{0,18}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 removed_at timestamptz,
 removed_by uuid,
 removed_by_version text CHECK (removed_by_version ~ '^[1-9][0-9]{0,18}$'),
 CHECK ((removed_at IS NULL) = (removed_by IS NULL) AND (removed_by IS NULL) = (removed_by_version IS NULL))
);
CREATE UNIQUE INDEX device_allowlist_one_active_mac ON device_allowlist_entries(mac_address) WHERE removed_at IS NULL;
CREATE INDEX device_allowlist_active ON device_allowlist_entries(created_at,id) WHERE removed_at IS NULL;
-- An entry is added once and removed at most once. Labels and addresses are
-- never rewritten, so the audit trail always describes the router binding.
CREATE FUNCTION device_allowlist_preserve_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.removed_at IS NOT NULL OR
    (to_jsonb(NEW)-ARRAY['removed_at','removed_by','removed_by_version'])
    IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['removed_at','removed_by','removed_by_version']) THEN
  RAISE EXCEPTION 'device_allowlist_entry_immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER device_allowlist_entry_immutable BEFORE UPDATE ON device_allowlist_entries
 FOR EACH ROW EXECUTE FUNCTION device_allowlist_preserve_entry();

-- Who changed what and why. Administrator events carry the reason and the
-- idempotency key; router events record each binding write the reconciler
-- sent on behalf of the administrator who started that synchronization.
CREATE TABLE device_allowlist_events (
 id uuid PRIMARY KEY,
 entry_id uuid NOT NULL,
 event_type text NOT NULL CHECK (event_type IN ('added','removed','router_binding_added','router_binding_removed')),
 actor_id uuid NOT NULL,
 actor_version text NOT NULL CHECK (actor_version ~ '^[1-9][0-9]{0,18}$'),
 nas_id uuid,
 mac_address text CHECK (mac_address ~ '^[0-9A-F]{2}(:[0-9A-F]{2}){5}$'),
 label text CHECK (char_length(label) BETWEEN 1 AND 80),
 reason text CHECK (char_length(reason) BETWEEN 10 AND 500),
 request_key uuid,
 request_hash text CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (CASE WHEN event_type IN ('added','removed')
  THEN nas_id IS NULL AND mac_address IS NOT NULL AND label IS NOT NULL AND reason IS NOT NULL AND request_key IS NOT NULL AND request_hash IS NOT NULL
  ELSE nas_id IS NOT NULL AND reason IS NULL AND request_key IS NULL AND request_hash IS NULL END),
 UNIQUE (actor_id,request_key)
);
CREATE INDEX device_allowlist_events_history ON device_allowlist_events(created_at DESC,id);

-- Latest observation per router and per approved device on that router.
CREATE TABLE device_allowlist_router_status (
 nas_id uuid PRIMARY KEY,
 status text NOT NULL CHECK (status IN ('synced','attention','unreachable')),
 error_code text CHECK (error_code ~ '^[a-z_]{1,64}$'),
 attempted_at timestamptz NOT NULL,
 synced_at timestamptz,
 added integer NOT NULL DEFAULT 0 CHECK (added>=0),
 removed integer NOT NULL DEFAULT 0 CHECK (removed>=0),
 conflicts integer NOT NULL DEFAULT 0 CHECK (conflicts>=0),
 pending_removals integer NOT NULL DEFAULT 0 CHECK (pending_removals>=0),
 triggered_by uuid NOT NULL
);
CREATE TABLE device_allowlist_router_devices (
 entry_id uuid NOT NULL REFERENCES device_allowlist_entries(id),
 nas_id uuid NOT NULL,
 state text NOT NULL CHECK (state IN ('applied','conflict','missing')),
 observed_at timestamptz NOT NULL,
 PRIMARY KEY (entry_id,nas_id)
);
