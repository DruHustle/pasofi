# Hosting and environment boundaries

## Local demonstration

`compose.yaml` starts persistent PostgreSQL and five independent services. Development ports are loopback-only. Credentials and seed are public demo values; providers are not configured.

The startup helper applies migrations separately and waits for bounded readiness checks. A dropped idle database connection no longer exits the process through an unhandled error event. Readiness remains distinct from liveness.

## Private Oracle staging

`infra/oracle-staging/compose.yaml` describes an internal network with no published ports, unpublished bundles, disabled simulated payments and disabled RADIUS lab authority. It uses distinct externally supplied credentials and an explicit image release tag. All five application containers have readiness health checks.

Earlier repository notes record a dedicated Oracle staging VM. This source review did not inspect or deploy it. Editing these files does not update the running environment.

The staging test creates a temporary Compose project and generated credentials, checks readiness, disabled purchase paths and database isolation, then cleans up only that project.

## Public web preview

The Vercel configuration serves a labelled frontend preview. No public backend URL is configured in the repository. The UI displays unavailable/empty states when no API can be reached. Do not substitute private staging or enable payments merely to remove an error.

The nginx frontend forwards only customer catalogue, help, session, recovery, order and access routes. It does not expose internal authority, callbacks or credentials.

## Before serving customers

Complete and qualify HTTPS ingress, trusted service transport, secret rotation, staff access, provider/router integration, separate runtime/migration roles, capacity limits, monitoring, encrypted independent backups, restore/fencing and rollback. See [BUILD_STATUS.md](BUILD_STATUS.md) and [BACKUPS.md](BACKUPS.md).

Verification performs no hosting migration, DNS change, payment/SMS activation or deployment.
