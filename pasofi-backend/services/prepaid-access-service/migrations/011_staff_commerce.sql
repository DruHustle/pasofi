CREATE TABLE sales_locations (
 id uuid PRIMARY KEY, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_site_inventory (
 agent_id uuid NOT NULL, site_id uuid NOT NULL REFERENCES sales_locations(id), bundle_id text NOT NULL REFERENCES bundle_versions(id),
 quantity integer NOT NULL DEFAULT 0 CHECK(quantity>=0), PRIMARY KEY(agent_id,site_id,bundle_id)
);
CREATE TABLE inventory_allocations (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL, request_key uuid NOT NULL, agent_id uuid NOT NULL,
 site_id uuid NOT NULL REFERENCES sales_locations(id),bundle_id text NOT NULL REFERENCES bundle_versions(id),
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100000),reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 500),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(actor_id,request_key)
);
ALTER TABLE agent_sales ADD COLUMN site_name text NOT NULL DEFAULT '';
ALTER TABLE agent_sales ADD COLUMN commission_bps integer NOT NULL DEFAULT 0 CHECK(commission_bps BETWEEN 0 AND 10000);
ALTER TABLE agent_sales ADD COLUMN commission_minor integer NOT NULL DEFAULT 0 CHECK(commission_minor>=0 AND commission_minor<=price_minor);
ALTER TABLE agent_sales ADD COLUMN delivery text NOT NULL DEFAULT 'receipt' CHECK(delivery IN ('receipt','sms','both'));
ALTER TABLE agent_sales ADD COLUMN simulation boolean NOT NULL DEFAULT true;
ALTER TABLE agent_sales ADD COLUMN request_hash bytea;
ALTER TABLE issued_vouchers ADD COLUMN key_id text NOT NULL DEFAULT 'legacy';
CREATE TABLE agent_sale_deliveries (
 sale_id uuid PRIMARY KEY REFERENCES agent_sales(id),channel text NOT NULL CHECK(channel IN ('receipt','sms','both')),
 key_id text NOT NULL,payload_cipher bytea NOT NULL,payload_iv bytea NOT NULL CHECK(octet_length(payload_iv)=12),payload_tag bytea NOT NULL CHECK(octet_length(payload_tag)=16),
 paired_customer_id uuid
);
CREATE TABLE receipt_pairings (
 id uuid PRIMARY KEY,customer_id uuid NOT NULL,request_key uuid NOT NULL,
 code_hash bytea NOT NULL UNIQUE CHECK(octet_length(code_hash)=32),key_id text NOT NULL,
 code_cipher bytea NOT NULL,code_iv bytea NOT NULL CHECK(octet_length(code_iv)=12),code_tag bytea NOT NULL CHECK(octet_length(code_tag)=16),
 sale_id uuid UNIQUE REFERENCES agent_sales(id),created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 UNIQUE(customer_id,request_key)
);
CREATE INDEX receipt_pairings_customer_idx ON receipt_pairings(customer_id,created_at DESC);
CREATE TABLE commerce_audit (
 id uuid PRIMARY KEY,actor_id uuid NOT NULL,action text NOT NULL,target_id uuid NOT NULL,
 reason text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE purchase_orders ADD COLUMN purchase_mode text NOT NULL DEFAULT 'demo' CHECK(purchase_mode IN ('demo','checkout'));
CREATE TABLE mock_provider_payments (
 reference text PRIMARY KEY,order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','verified_success','failed','reversed')),created_at timestamptz NOT NULL DEFAULT now()
);
