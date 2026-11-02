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

The owner's preferred path is **direct WireGuard to the router without a separate VPN server**. This is possible when its UDP endpoint is reachable through public IPv4 (including an upstream router's deliberate UDP forwarding) or usable global IPv6 from the remote client. A private upstream address such as the observed `192.168.0.1` proves an upstream private network; it does not establish ISP CGNAT or rule out either direct path. Public reachability and the IPv6 route have not yet been inspected or tested at this site.

The [remote-management tools](../infra/remote-access/README.md) prepare either that direct owner-to-router connection or the existing outbound router WireGuard tunnel to a public Linux hub. The hub is a fallback when a direct endpoint is unavailable; Tailscale on the hub advertises only the router's management `/32`. A local Tailscale subnet router would instead require an always-on supported site device, which the owner does not have. The SMIPS hAP lite does not support MikroTik Back to Home or a normal Tailscale installation.

All generated plans are offline review artifacts. The owner client receives only the dedicated router management route, not the customer LAN or a default internet route. Public ingress permits the selected WireGuard UDP endpoint; WebFig, WinBox, API and databases are not published to the internet. Source generation does not create a tunnel, grant access or prove reachability. Separate-network login, denied-source/LAN tests, reboot recovery and preserved local access are required before activation is recorded as complete.

Direct owner access does **not** remove PamoFi's backend hosting requirement. Identity, the usage ledger, RADIUS authority, payments and delivery workers still need their service environment. The backend's RouterOS HTTPS/RADIUS path must be qualified separately with its own identity and least-privilege access; it must not depend on the owner's phone remaining connected.

References: [RouterOS WireGuard](https://manual.mikrotik.com/docs/virtual-private-networks/wireguard/), [Back to Home architecture requirements](https://manual.mikrotik.com/docs/network-management/cloud/back-to-home/), and [Tailscale subnet routers](https://tailscale.com/docs/features/subnet-routers).

## Deployment acceptance

Qualify real TLS/secret custody, role grants, gateway paths and egress; then actual merchant/SMS methods, physical router enforcement, native cookies, capacity, monitoring and operator procedures. Configure [independent encrypted recovery](BACKUPS.md), test restoration with external fencing, and exercise release rollback. [BUILD_STATUS.md](BUILD_STATUS.md) records the completed software checks and the external work still outstanding.

The [operations checker and runbook](../infra/operations/README.md) provide read-only health, exposure, queue and backup diagnostics plus an explicit release/rollback procedure. They do not install a scheduler or send alerts. Record actual scheduled execution and a deliberate alert-delivery test before treating monitoring as active.
