CREATE TABLE access_grants (
 id uuid PRIMARY KEY,
 customer_id uuid NOT NULL,
 entitlement_id uuid NOT NULL REFERENCES purchase_entitlements(id),
 site_id uuid NOT NULL,
 generation uuid NOT NULL UNIQUE,
 state text NOT NULL CHECK (state IN ('pending','active','uncertain','closed')),
 reserved_bytes bigint NOT NULL CHECK (reserved_bytes > 0),
 charged_bytes bigint NOT NULL DEFAULT 0 CHECK (charged_bytes >= 0 AND charged_bytes <= reserved_bytes),
 upload_high numeric(20,0) NOT NULL DEFAULT 0 CHECK (upload_high >= 0),
 download_high numeric(20,0) NOT NULL DEFAULT 0 CHECK (download_high >= 0),
 issued_at timestamptz NOT NULL DEFAULT now(),
 deadline timestamptz NOT NULL,
 closed_at timestamptz,
 CHECK (deadline > issued_at),
 CHECK ((state = 'closed') = (closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_live_or_uncertain_grant_per_customer ON access_grants(customer_id) WHERE state <> 'closed';
CREATE INDEX access_grants_entitlement_idx ON access_grants(entitlement_id);
