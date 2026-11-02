# PamoFi help

The assistant provides reviewed public guidance with no model dependency. It explains bundle timing/data accounting, pending payments, top-ups, planned vouchers, recovery, key replacement, shared-browser sign-out and preview limits.

`GET /v1/help` returns versioned articles with stable IDs, categories, questions and answers. Optional `q` searches reviewed text case-insensitively; it is limited to 200 characters and requires every word to match. Unsupported questions return an empty list. The web interface searches loaded articles locally and offers loading, unavailable and retry states.

Help has no payment, activation, allowance, account mutation or router action. It does not need recovery keys, payment credentials or voucher codes. It never claims a current balance, payment result or live site status. Future personalized reads must be authorized by the owning service.

FAQ remains available when the database is unavailable; readiness is separate. Responses use `Cache-Control: no-store`. Tests cover bounded search, unsupported requests, read-only behavior and recovery from an idle database failure.

Optional models, personal assistance, staff publication and site-status reads remain future work. A model must not gain direct database or network authority.
