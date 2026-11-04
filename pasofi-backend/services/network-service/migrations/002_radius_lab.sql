-- Lab-only registry. Runtime never reads the prepaid service database.
CREATE TABLE radius_nas (
 id uuid PRIMARY KEY,
 site_id uuid NOT NULL,
 client_name text NOT NULL UNIQUE CHECK (client_name ~ '^[A-Za-z0-9_-]{1,64}$'),
 enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE radius_credentials (
 id uuid PRIMARY KEY,
 username text NOT NULL UNIQUE CHECK (username ~ '^[A-Za-z0-9_-]{16,128}$'),
 secret_hash bytea NOT NULL CHECK (octet_length(secret_hash)=32),
 customer_id uuid NOT NULL,
 nas_id uuid NOT NULL REFERENCES radius_nas(id),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
