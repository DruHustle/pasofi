CREATE TABLE customer_recovery (
 customer_id uuid PRIMARY KEY REFERENCES customers(id),
 account_reference text NOT NULL UNIQUE CHECK(length(account_reference)=14),
 key_hash bytea NOT NULL CHECK(octet_length(key_hash)=32),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
