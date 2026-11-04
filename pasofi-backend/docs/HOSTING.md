# Hosting and environment boundaries

## Selected deployment

The owner selected **Vercel for the web frontend, Oracle for the backend, and Starlink upstream of each MikroTik**. The owner originally selected the shared Onesa UG Backend for the PamoFi production backend. The website is https://pamofi.onesa.eu and the API is https://api.pamofi.onesa.eu. Actual deployment identities, image IDs and remaining acceptance work are recorded in the [Onesa deployment evidence](../local-tools/release-evidence/2026-11-02-onesa-production/README.md).

On 3 November 2026, Oracle inventory showed three distinct running instances: `Onesa UG Backend`, `PamoFi Backend`, and `Software Engineering Backend`. PamoFi’s production containers were observed on `Onesa UG Backend` in `onesa-portal-worker-vcn`. The separate `PamoFi Backend` instance was attached to `software-engineering-backend-vcn`; its existence alone does not mean production runs there. The owner confirmed that PamoFi should remain on `Onesa UG Backend` as an Onesa product. No migration was performed by this inventory. Oracle permits multiple instances in a VCN; a separate VCN can be chosen for isolation. The existing PamoFi instance has one supported VNIC, and its primary VNIC cannot be detached to change VCNs in place.

See [Oracle capacity and scaling](SCALING.md) for the current tenancy inventory, free-tier limits and a staged path toward Kubernetes.

The current work completes and tests software before physical hotspot acceptance. Source configuration, isolated service tests and native compilation do not activate a cloud deployment, a payment method or a router.

| Connection | Intended path |
| --- | --- |
| Customer/agent browser | Vercel web application and same-origin public `/api` requests |
| Web API forwarding | Server-side Vercel function over authenticated HTTPS to the Oracle gateway |
| Business authority | Five independent services and five owned PostgreSQL databases on Oracle |
| Site control | MikroTik initiates an outbound WireGuard connection to the Oracle host |
| Customer internet | Customer network through MikroTik and Starlink; no customer/default route through Oracle |

Starlink documents default IPv4 CGNAT with inbound traffic blocked, and its Wi-Fi router does not offer port forwarding or custom IPv4/IPv6 firewall rules. Therefore the selected site connection must not depend on a port-forward on the Starlink router. The outbound tunnel uses a public Oracle endpoint and a keepalive; no additional always-on site computer or separate VPN VM is required by this design. A separate owner-to-router direct IPv4/IPv6 option can still be assessed where a reachable path actually exists.

## Local demonstration

`compose.yaml` starts persistent PostgreSQL and five independent services on loopback development ports. Credentials and seeded catalogue are public demo values. The startup helper applies migrations separately and waits for bounded readiness. Readiness remains distinct from liveness, and idle database errors do not terminate a service through unhandled pool events.

New commerce, provider, SMS and network features have explicit configuration gates. The strict test runner provisions synthetic keys and mock modes for its owned processes; it never converts demo configuration into a live service.

## Private Oracle staging

`infra/oracle-staging/compose.yaml` uses private networking, unpublished bundles, disabled simulated payments and disabled RADIUS lab authority. It publishes no public service. Earlier notes record a dedicated Oracle staging VM; source edits do not establish that the current revision was deployed there.

The staging lab creates its own temporary Compose project and credentials, checks readiness, disabled purchase paths and database isolation, then cleans up only its resources.

## Public frontend and production source

The Vercel project root is `pasofi-frontend/web`, with `npm ci`, `npm run build` and output `dist`. The server-side API proxy preserves browser-visible same-origin requests and host-only secure cookies. Its Oracle destination, exact frontend origin and proxy credential are server configuration, never `VITE_*` values or browser assets. An unconfigured preview refuses API forwarding.

The Oracle split-host gateway authenticates that proxy and derives rate-limit identity only from its reviewed client-IP header. Ordinary caller-supplied forwarding headers are not authority. The frontend origin is configured separately from the Oracle TLS hostname. Multiple cookies, exact Origin checks, no-store responses, methods, bodies and query strings must survive both hops; internal endpoints and arbitrary destinations remain unreachable. See the frontend README and production split-host runbook for exact configuration and qualification commands.

The Nginx frontend explicitly forwards reviewed public customer, staff, administration, receipt, checkout and network-control routes. It preserves request methods, bodies, cookies and origin checks and rejects unknown/internal API paths. Network customer requests go through prepaid authority; no public request can choose an internal router-management URL.

The [production foundation](../infra/production/README.md) adds a public TLS ingress contract, a private TLS service gateway, protected file-based secrets, separate database owner/migration/runtime identities, explicit grant manifests and release-image inputs. The default single-host deployment remains available; the Vercel/Oracle split is explicit. These source tools support the separately verified Onesa deployment. Its encrypted configuration, persistent database volume, TLS gateway and ARM64 image identities must be preserved during changes; real cash commerce and physical hotspot activation still require their own acceptance.

## Private router management

The first hAP lite was [inspected read-only](../pasofi-routeros/site-01/INSPECTION.md). It has no configured customer HotSpot or RADIUS server and HTTPS management is disabled. Existing home LAN and wireless settings were preserved.

The owner also requested **direct WireGuard to the router without a separate VPN server**. This remains an optional owner-access path when its UDP endpoint is reachable through public IPv4 or usable global IPv6. The later local inspection found a DHCP uplink behind `192.168.0.1`, no global IPv6/default IPv6 route, and no configured WireGuard interface. That local private gateway alone does not establish ISP CGNAT. Production Starlink's documented default policy is separate evidence and motivates the outbound Oracle site connection.

The [site-link preparation](../infra/site-link/README.md) is separate from owner access: it prepares the outbound control connection and narrow service traffic needed by the [production RADIUS package](../infra/radius-production/README.md). Router authentication/accounting and backend HTTPS management use dedicated identities and scoped tunnel addresses. The Oracle listener must bind only to the reviewed private tunnel address; cloud or host firewalls must not publish RADIUS to the internet. Customer traffic stays on the Starlink route.

The current RADIUS authority accepts the PAP/User-Password contract. The physical HotSpot must present a trusted HTTPS login page and carry RADIUS inside the encrypted site tunnel; CHAP, MSCHAP and EAP are unsupported and must fail closed. Qualification must verify the actual login profile, session identity and Message-Authenticator behavior, rather than assume a default RouterOS login page matches the software.

The optional [RouterOS control overlay](../infra/production/ROUTER_CONTROL.md) wires the existing disconnect/re-query worker to protected per-device configuration and a public-certificate-only trust mount. Its dedicated Docker route can reach the private tunnel; the generated site firewall restricts the peer and HTTPS direction. The base deployment leaves the worker disabled, and its offline preflight cannot substitute for device identity, TLS and disconnect/accounting acceptance.

The [remote-management tools](../infra/remote-access/README.md) prepare either that direct owner-to-router connection or the existing outbound router WireGuard tunnel to a public Linux hub. The hub is a fallback when a direct endpoint is unavailable; Tailscale on the hub advertises only the router's management `/32`. A local Tailscale subnet router would instead require an always-on supported site device, which the owner does not have. The SMIPS hAP lite does not support MikroTik Back to Home or a normal Tailscale installation.

All generated plans are offline review artifacts. The owner client receives only the dedicated router management route, not the customer LAN or a default internet route. Public ingress permits the selected WireGuard UDP endpoint; WebFig, WinBox, API and databases are not published to the internet. Source generation does not create a tunnel, grant access or prove reachability. Separate-network login, denied-source/LAN tests, reboot recovery and preserved local access are required before activation is recorded as complete.

Direct owner access does **not** remove PamoFi's backend hosting requirement. Identity, the usage ledger, RADIUS authority, payments and delivery workers still need their service environment. The backend's RouterOS HTTPS/RADIUS path must be qualified separately with its own identity and least-privilege access; it must not depend on the owner's phone remaining connected.

References: [RouterOS WireGuard](https://help.mikrotik.com/docs/spaces/ROS/pages/69664792/WireGuard), [Starlink IP allocation and inbound restrictions](https://starlink.com/de/support/article/1192f3ef-2a17-31d9-261a-a59d215629f4), [Starlink VPN compatibility](https://starlink.com/mg/support/article/e5dc0b86-09b4-084b-918b-3fa181e5fb5d), [Back to Home architecture requirements](https://manual.mikrotik.com/docs/network-management/cloud/back-to-home/), and [Tailscale subnet routers](https://tailscale.com/docs/features/subnet-routers).

## Deployment acceptance

Qualify real TLS/secret custody, role grants, gateway paths and egress; then actual merchant/SMS methods, physical router enforcement, native cookies, capacity, monitoring and operator procedures. Configure [independent encrypted recovery](BACKUPS.md), test restoration with external fencing, and exercise release rollback. [BUILD_STATUS.md](BUILD_STATUS.md) records the completed software checks and the external work still outstanding.

The [operations checker and runbook](../infra/operations/README.md) provide read-only health, exposure, queue and backup diagnostics plus an explicit release/rollback procedure. The Onesa-specific [scheduler and alert installers](../local-tools/manual%20deployment/onesa/README.md) record the deployed timers and notifications. The owner confirmed delivery of a test notification; keep monitoring and restore drills under review.
