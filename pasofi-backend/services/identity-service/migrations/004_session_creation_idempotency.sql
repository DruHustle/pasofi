-- A short-lived retry secret can recover the first response without storing the
-- secret or session cookie. Cascades ensure revoked/deleted sessions cannot be
-- recreated by a stale request record.
CREATE TABLE customer_session_creations (
 request_hash bytea PRIMARY KEY CHECK(octet_length(request_hash)=32),
 session_token_hash bytea NOT NULL REFERENCES customer_sessions(token_hash) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_session_creations_expiry_idx ON customer_session_creations(expires_at);
