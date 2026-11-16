-- A contradictory router sighting can reveal more than one physical session
-- for a customer. Keep the issuance invariant for pending/active grants, but
-- allow multiple uncertain grants so every observed session can be fenced and
-- disconnected independently while the customer-level hold blocks new access.
DROP INDEX one_live_or_uncertain_grant_per_customer;
CREATE UNIQUE INDEX one_issuable_grant_per_customer
 ON access_grants(customer_id) WHERE state IN ('pending','active');
