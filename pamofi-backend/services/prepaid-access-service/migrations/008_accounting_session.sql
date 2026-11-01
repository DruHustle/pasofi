ALTER TABLE access_grants ADD COLUMN accounting_session_id text;
ALTER TABLE access_grants ADD CONSTRAINT accounting_session_length CHECK(accounting_session_id IS NULL OR length(accounting_session_id) BETWEEN 1 AND 128);
