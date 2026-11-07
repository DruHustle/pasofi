-- Test Stripe payments have a distinct ledger identity and cannot be mistaken
-- for live money. This migration enables no checkout or production gate.
ALTER TABLE provider_payment_attempts DROP CONSTRAINT provider_payment_attempts_provider_check;
ALTER TABLE provider_payment_attempts ADD CONSTRAINT provider_payment_attempts_provider_check
 CHECK(provider IN ('pesepay','mock','stripe','stripe_test'));

-- Keep only event identifiers, not raw events, card details or client secrets.
-- The insert and reconciliation enqueue commit together for retry-safe delivery.
CREATE TABLE stripe_webhook_events (
 provider text NOT NULL CHECK(provider IN ('stripe','stripe_test')),
 event_id text NOT NULL CHECK(event_id ~ '^evt_[A-Za-z0-9]+$'),
 event_type text NOT NULL,
 provider_reference text NOT NULL CHECK(provider_reference ~ '^pi_[A-Za-z0-9]+$'),
 received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(provider,event_id)
);
