# Hosting and environment boundaries

## Local demonstration

`compose.yaml` starts persistent PostgreSQL and five independent services on loopback development ports. Credentials and seeded catalogue are public demo values. The startup helper applies migrations separately and waits for bounded readiness. Readiness remains distinct from liveness, and idle database errors do not terminate a service through unhandled pool events.

New commerce, provider, SMS and network features have explicit configuration gates. The strict test runner provisions synthetic keys and mock modes for its owned processes; it never converts demo configuration into a live service.

## Private Oracle staging

`infra/oracle-staging/compose.yaml` uses private networking, unpublished bundles, disabled simulated payments and disabled RADIUS lab authority. It publishes no public service. Earlier notes record a dedicated Oracle staging VM; source edits do not establish that the current revision was deployed there.

The staging lab creates its own temporary Compose project and credentials, checks readiness, disabled purchase paths and database isolation, then cleans up only its resources.

## Public frontend and production source

The existing Vercel configuration serves the frontend without a configured public backend. It displays demo or unavailable states when the API is absent. It is not an API gateway to private staging.

The Nginx frontend explicitly forwards reviewed public customer, staff, administration, receipt, checkout and network-control routes. It preserves request methods, bodies, cookies and origin checks and rejects unknown/internal API paths. Network customer requests go through prepaid authority; no public request can choose an internal router-management URL.

The [production foundation](../infra/production/README.md) adds a public TLS ingress contract, a private TLS service gateway, protected file-based secrets, separate database owner/migration/runtime identities, explicit grant manifests and release-image inputs. These are source configuration and guarded verification tools, not a deployment. The operator must choose and authenticate the public host, supply a real hostname/certificates, create the intended persistent database volume, select immutable images and verify actual transport/permissions before activation.

## Private router management

The first hAP lite was [inspected read-only](../pamofi-routeros/site-01/INSPECTION.md). It has no configured customer HotSpot or RADIUS server and HTTPS management is disabled. Existing home LAN and wireless settings were preserved.

With no always-on site device, the prepared [remote-management design](../infra/remote-access/README.md) uses an outbound router WireGuard tunnel to a public Linux hub. Tailscale on the hub advertises only the router's management `/32` to the verified owner. No public hub or authenticated tailnet has been selected and no tunnel, route, new account or management grant has been activated by the source generator.

## Deployment acceptance

Qualify real TLS/secret custody, role grants, gateway paths and egress; then actual merchant/SMS methods, physical router enforcement, native cookies, capacity, monitoring and operator procedures. Configure [independent encrypted recovery](BACKUPS.md), test restoration with external fencing, and exercise release rollback. [BUILD_STATUS.md](BUILD_STATUS.md) records the completed software checks and the external work still outstanding.

The [operations checker and runbook](../infra/operations/README.md) provide read-only health, exposure, queue and backup diagnostics plus an explicit release/rollback procedure. They do not install a scheduler or send alerts. Record actual scheduled execution and a deliberate alert-delivery test before treating monitoring as active.
