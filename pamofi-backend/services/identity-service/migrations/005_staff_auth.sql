-- Staff identities are separate from anonymous customer identities. Registration
-- never creates an approved role; only a serialized, audited decision may do so.
CREATE TABLE staff_users (
  id uuid PRIMARY KEY,
  email varchar(254) NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name varchar(80) NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','disabled')),
  role text CHECK (role IN ('admin','agent','support')),
  site_ids uuid[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  mfa_secret_ciphertext text,
  mfa_enrolled_at timestamptz,
  mfa_last_counter bigint NOT NULL DEFAULT -1,
  failed_passwords integer NOT NULL DEFAULT 0 CHECK (failed_passwords >= 0),
  failed_mfa integer NOT NULL DEFAULT 0 CHECK (failed_mfa >= 0),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((mfa_secret_ciphertext IS NULL) = (mfa_enrolled_at IS NULL)),
  CHECK (status <> 'pending' OR (role IS NULL AND cardinality(site_ids) = 0)),
  CHECK (status <> 'approved' OR
    ((role = 'admin' AND cardinality(site_ids) = 0) OR
     (role IN ('agent','support') AND cardinality(site_ids) BETWEEN 1 AND 100)))
);

CREATE TABLE staff_auth_challenges (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  staff_id uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  staff_version integer NOT NULL,
  enrollment_ciphertext text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_auth_challenges_staff_idx ON staff_auth_challenges(staff_id);

CREATE TABLE staff_sessions (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  staff_id uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  staff_version integer NOT NULL,
  mfa_verified_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_sessions_staff_idx ON staff_sessions(staff_id);

CREATE TABLE staff_audit_events (
  id uuid PRIMARY KEY,
  actor_staff_id uuid,
  target_staff_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('bootstrap','decision','revoke_sessions')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  previous_version integer,
  new_version integer NOT NULL,
  before_state jsonb,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- No foreign key to an actor/target: the history must survive identity removal
-- during a retention process. Application requests cannot update/delete history.
CREATE FUNCTION reject_staff_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'staff audit events are append only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER staff_audit_append_only BEFORE UPDATE OR DELETE ON staff_audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_staff_audit_mutation();

-- A permanent singleton prevents a second bootstrap, including after all
-- original administrators have been disabled. Recovery is an explicit operation.
CREATE TABLE staff_bootstrap_guard (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  staff_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
