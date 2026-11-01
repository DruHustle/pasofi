# Architecture and immediate plan

The intended authority split is identity, prepaid access, network, notifications and assistant, each with its own database. Financial and allowance authority belongs only to prepaid access. This initial slice provides separate Fastify processes, a separate database and database role per service, a PostgreSQL-backed demo catalogue, and read-only FAQ content. The separately run frontend development server proxies the demo catalogue and help APIs. Production routing is not configured.

Implementation sequence: (1) complete secure identity and internal service authentication; (2) implement transactional purchase, entitlement, global grant and accounting ledger with PostgreSQL concurrency tests; (3) implement real FreeRADIUS integration and two-NAS lab, failing closed; (4) add agent stock, voucher issuance, private receipts, recovery and durable events; (5) integrate and qualify payment, SMS and deployment/backup systems; (6) finish customer/staff journeys and acceptance tests. Full details and unverified items are in BUILD_STATUS.md.

No business service is authorized by the present health endpoint. No payment, access or cross-service RPC endpoint exists yet. Demo FAQ text is reviewed static content and deliberately does not claim current balances, payment or site status.
