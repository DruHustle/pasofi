ALTER TABLE purchase_entitlements ADD COLUMN revoked_at timestamptz;
CREATE TABLE provider_payment_attempts (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES purchase_orders(id), customer_id uuid NOT NULL,
 request_key uuid NOT NULL, site_id uuid NOT NULL, method_code text NOT NULL, provider text NOT NULL CHECK(provider='pesepay'),
 state text NOT NULL CHECK(state IN ('initiating','unknown','pending','succeeded','failed','reversed','review')),
 provider_reference text UNIQUE, redirect_url text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(customer_id,request_key)
);
CREATE UNIQUE INDEX one_unresolved_provider_attempt_per_order ON provider_payment_attempts(order_id) WHERE state IN ('initiating','unknown','pending');
CREATE TABLE verified_charges (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES purchase_orders(id),
 attempt_id uuid NOT NULL UNIQUE REFERENCES provider_payment_attempts(id), provider_reference text NOT NULL UNIQUE,
 amount_minor integer NOT NULL, currency char(3) NOT NULL, fulfilled_entitlement_id uuid UNIQUE REFERENCES purchase_entitlements(id),
 state text NOT NULL CHECK(state IN ('succeeded','reversed')), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payment_reviews (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES purchase_orders(id), charge_id uuid REFERENCES verified_charges(id),
 reason text NOT NULL CHECK(reason IN ('duplicate_charge','consumed_reversal','provider_reference_conflict')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(charge_id,reason)
);
