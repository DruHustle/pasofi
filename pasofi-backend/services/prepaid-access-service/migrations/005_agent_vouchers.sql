CREATE TABLE agent_inventory (
 agent_id uuid NOT NULL, bundle_id text NOT NULL REFERENCES bundle_versions(id),
 quantity integer NOT NULL CHECK(quantity >= 0), PRIMARY KEY(agent_id,bundle_id)
);
CREATE TABLE agent_sales (
 id uuid PRIMARY KEY, agent_id uuid NOT NULL, site_id uuid NOT NULL,
 idempotency_key uuid NOT NULL, bundle_id text NOT NULL, price_minor integer NOT NULL,
 currency char(3) NOT NULL, byte_limit bigint NOT NULL, validity_seconds integer NOT NULL,
 sold_at timestamptz NOT NULL DEFAULT now(), start_by timestamptz NOT NULL,
 UNIQUE(agent_id,idempotency_key)
);
CREATE TABLE issued_vouchers (
 id uuid PRIMARY KEY, sale_id uuid NOT NULL REFERENCES agent_sales(id), parent_id uuid REFERENCES issued_vouchers(id),
 code_hash bytea NOT NULL UNIQUE CHECK(octet_length(code_hash)=32),
 code_cipher bytea NOT NULL, code_iv bytea NOT NULL CHECK(octet_length(code_iv)=12),
 code_tag bytea NOT NULL CHECK(octet_length(code_tag)=16),
 state text NOT NULL CHECK(state IN ('valid','redeemed','revoked')),
 redeemed_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((state='redeemed') = (redeemed_by IS NOT NULL))
);
CREATE UNIQUE INDEX one_live_voucher_per_sale ON issued_vouchers(sale_id) WHERE state IN ('valid','redeemed');
ALTER TABLE purchase_entitlements ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE purchase_entitlements ADD COLUMN source_voucher_id uuid UNIQUE REFERENCES issued_vouchers(id);
ALTER TABLE purchase_entitlements ADD CONSTRAINT entitlement_one_source CHECK ((order_id IS NULL) <> (source_voucher_id IS NULL));
CREATE TABLE event_outbox (
 id uuid PRIMARY KEY, event_type text NOT NULL, event_version integer NOT NULL,
 aggregate_id uuid NOT NULL, aggregate_version integer NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
 correlation_id uuid NOT NULL, payload jsonb NOT NULL, dispatched_at timestamptz
);
