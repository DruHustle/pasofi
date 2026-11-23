-- EcoCash Online Payments checkout ledger identity and payer context.
-- This migration enables nothing: new EcoCash checkout additionally requires
-- PAMOFI_ECOCASH_CHECKOUT_ENABLED and every gate in ecocash-checkout.ts.
-- ecocash_test is the sandbox identity and can never be mistaken for live money.
ALTER TABLE provider_payment_attempts DROP CONSTRAINT provider_payment_attempts_provider_check;
ALTER TABLE provider_payment_attempts ADD CONSTRAINT provider_payment_attempts_provider_check
 CHECK(provider IN ('pesepay','mock','stripe','stripe_test','ecocash','ecocash_test'));

-- Committed in the same transaction as the attempt, before any provider POST.
-- The payer number is sealed (AES-256-GCM, attempt-bound AAD); only the last
-- three digits are kept in clear for the customer's own confirmation screen.
CREATE TABLE ecocash_checkout_contexts (
 attempt_id uuid PRIMARY KEY REFERENCES provider_payment_attempts(id),
 environment text NOT NULL CHECK(environment IN ('sandbox','production')),
 merchant_code text NOT NULL CHECK(length(merchant_code) BETWEEN 1 AND 64),
 payer_key_id text NOT NULL CHECK(payer_key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
 payer_iv bytea NOT NULL,
 payer_cipher bytea NOT NULL,
 payer_tag bytea NOT NULL,
 payer_hint text NOT NULL CHECK(payer_hint ~ '^[0-9]{3}$'),
 ecocash_reference text UNIQUE CHECK(ecocash_reference ~ '^[A-Za-z0-9._-]{1,128}$'),
 created_at timestamptz NOT NULL DEFAULT now()
);
