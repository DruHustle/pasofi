CREATE TABLE IF NOT EXISTS bundle_versions (
 id text PRIMARY KEY, price_minor integer NOT NULL CHECK (price_minor > 0), currency char(3) NOT NULL,
 byte_limit bigint NOT NULL CHECK (byte_limit > 0), validity_seconds integer NOT NULL CHECK (validity_seconds > 0),
 published boolean NOT NULL DEFAULT false
);
