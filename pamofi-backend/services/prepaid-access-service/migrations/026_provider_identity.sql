-- Preserve historical Pesepay attempts while identifying synthetic activity
-- accurately. No direct provider is enabled or granted settlement authority.
ALTER TABLE provider_payment_attempts DROP CONSTRAINT provider_payment_attempts_provider_check;
ALTER TABLE provider_payment_attempts ADD CONSTRAINT provider_payment_attempts_provider_check
 CHECK(provider IN ('pesepay','mock'));

-- A matching local simulator record is positive evidence of the old mock path.
-- Ambiguous attempts without that evidence remain untouched for investigation.
UPDATE provider_payment_attempts a SET provider='mock'
 FROM mock_provider_payments m
 WHERE a.provider='pesepay' AND a.provider_reference=m.reference AND a.order_id=m.order_id;
