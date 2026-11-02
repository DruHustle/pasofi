# Independent service ownership

| Service | Database / role | Responsibilities |
| --- | --- | --- |
| identity-service | `pamofi_identity` | Customer sessions/recovery/handoff; staff password/MFA, roles/sites, approval/revocation audit |
| prepaid-access-service | `pamofi_prepaid_access` | Financial ledger, catalogue/sites, authorized sales/stock/receipts/vouchers, entitlements/grants/accounting, outbox |
| network-service | `pamofi_network` | NAS registry, temporary credentials, private RADIUS adapter, HTTPS router observations/disconnect |
| notification-service | `pamofi_notification` | Inbox, authenticated delivery lookup, worker leases, attempts/status and authorized resends |
| assistant-service | `pamofi_assistant` | Reviewed help; current public answers do not require account or catalogue access |

Every service has its own manifest, lockfile, TypeScript build, image, migration runner and OpenAPI file. There is no shared runtime package, cross-service source import or cross-service SQL in application paths. Test fixtures may inspect several isolated databases.

Customer/staff identity resolution, network authority, delivery lookup and event delivery use separately scoped short-lived tokens. RADIUS also requires mutual TLS and a pinned client certificate. Production transport and managed key rotation still need qualification.

Migration runners use advisory locking and verify checksums of applied files. Add a migration; do not edit an applied migration. Demo/staging use their documented non-production privileges. The production foundation separates non-login owner, migration and restricted runtime roles and applies reviewed grant manifests; qualify those roles on the deployment host.

Services handle idle database errors without exposing connection strings, remain alive for probes and reconnect. Compose checks each service's database readiness; a running process and a healthy dependency are distinguishable. Monitoring and alert delivery remain necessary before live operation.
