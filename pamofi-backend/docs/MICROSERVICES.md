# Independent service ownership

| Service | Database / role | Responsibilities |
| --- | --- | --- |
| identity-service | `pamofi_identity` | Sessions, recovery, creation retries, revocation |
| prepaid-access-service | `pamofi_prepaid_access` | Financial ledger, bundles, vouchers, stock, entitlements, grants, accounting, outbox |
| network-service | `pamofi_network` | NAS records, temporary credentials, private RADIUS lab adapter |
| notification-service | `pamofi_notification` | Inbox, delivery jobs, submissions, status |
| assistant-service | `pamofi_assistant` | Reviewed help; current public answers do not require account or catalogue access |

Every service has its own manifest, lockfile, TypeScript build, image, migration runner and OpenAPI file. There is no shared runtime package, cross-service source import or cross-service SQL in application paths. Test fixtures may inspect several isolated databases.

Identity resolution, lab authorization and event delivery use separately scoped short-lived tokens. RADIUS also requires mutual TLS and a pinned client certificate. Production transport and managed key rotation still need qualification.

Migration runners use advisory locking and verify checksums of applied files. Add a migration; do not edit an applied migration. Runtime/migration credentials are not yet separated in demo/staging.

Services handle idle database errors without exposing connection strings, remain alive for probes and reconnect. Compose checks each service's database readiness; a running process and a healthy dependency are distinguishable. Monitoring and alert delivery remain necessary before live operation.
