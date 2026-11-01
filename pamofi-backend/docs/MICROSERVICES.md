# Service ownership

| Service | Intended ownership | Current implementation |
| --- | --- | --- |
| identity | identities, sessions, recovery, staff/MFA | process and health endpoints only |
| prepaid access | catalogue, finance, vouchers, entitlement and grants | read-only demo catalogue |
| network | sites, routers, network commands and RADIUS adapter | process and health endpoints only |
| notification | delivery jobs and provider evidence | process and health endpoints only |
| assistant | reviewed help and scoped reads | public read-only static FAQ |

All five currently have separate manifests, lockfiles, Dockerfiles and database connections. The current demo has no service-to-service calls, internal authentication, durable jobs or outbox/inbox. PostgreSQL runtime users own their demo databases and are not suitable production migration/runtime separation.
