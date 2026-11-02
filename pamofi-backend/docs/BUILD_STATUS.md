# Build status — 2 November 2026

**Customer, staff, agent and administrator source flows are implemented and have passed isolated acceptance. Live prepaid Wi-Fi operation still requires external provider, router, mobile-cookie and deployment qualification.**

The review started at `d513eeec36f84c6cba6c8dd3f7168336ae3954d2` and was then expanded to finish the remaining product and operations source. The initial 81-test refinement pass and the later 126-test expanded pass are separate records; see [the review evidence](REVIEW_2026-11-02.md). Neither is a claim that a commercial hotspot or public deployment is running.

## Implemented capabilities and their operating boundaries

| Area | Current source behavior | Remaining qualification |
| --- | --- | --- |
| Independent projects | Five Fastify/TypeScript services, five owned databases, separate React/Vite web and Capacitor mobile builds | Release images, deployment host and runtime configuration must be selected and verified |
| Customer identity | HttpOnly sessions, exact-origin mutations, safe session-creation retry, versioned recovery, current-session revocation and two-minute single-use browser handoff | Native origin/cookie behavior and real captive/system-browser transitions |
| Staff identity | Password plus authenticator, pending applications, administrator approval, site scopes, versioned permission changes, session revocation and audit, permanent one-time first-admin bootstrap | Real staff enrollment, independent administrator recovery and operational key custody/rotation |
| Customer web tools | Voucher redemption, private paired receipts, capability-gated hosted checkout/status, access history, recovery, handoff and network controls | Merchant/provider acceptance and actual hotspot service remain disabled until qualified |
| Agent workspace | Assigned-site inventory, immutable sale terms and commission snapshots, atomic stock/voucher issuance, idempotent retries, private receipt and delivery evidence | Approved locations, staff, catalogue, commission policy and provider delivery acceptance |
| Administrator workspace | Staff approvals/site assignment, inventory allocation, immutable bundle versions/publication, sales/delivery/audit and exact-evidence network review | Real operator procedures and approved business terms; no arbitrary balance write-off |
| Financial authority | Exact minor-unit prices, transactional orders, source-specific fulfillment, charge reconciliation, duplicate/reversal review and authoritative fulfillment status | Qualified merchant methods/limits, provider evidence, monitoring and refund/review procedures |
| Notification | Reference-only outbox/inbox, authenticated encrypted delivery lookup, worker leases, status evidence, idempotent authorized resend and ambiguous-send protection | Qualified Sendai account/sender, real handset delivery and cost reconciliation |
| Network lifecycle | NAS-bound temporary credentials, RADIUS authorization/accounting, one active reservation, durable cumulative usage, disconnect requests, HTTPS RouterOS lookup/delete/re-query, credential fencing and evidence-bound closure/review | Actual first/second-router limits, isolation, TLS/tunnels, reboot/missing-accounting behavior and capacity acceptance |
| Mobile customer client | Configurable exact HTTPS API origin, credentialed CORS, same customer flow semantics, no token-storage bypass, useful offline preview when unavailable | Backend deliberately advertises `mobileCookies: false`; iOS/Android cookie, CORS/CSRF, provider return and captive Wi-Fi behavior remain unqualified |
| Production configuration | Public/private TLS gateway contracts, explicit proxy allowlists, secret-file entrypoint, independent owner/migration/runtime roles and reviewed grant manifest | Authenticated public host, hostname/certificates, real secrets, egress, monitoring, capacity, rotation and release/rollback evidence |
| Independent recovery | pgBackRest/B2 overlay, continuous WAL configuration, protected key inputs, retention/restore/fencing procedures and disposable recovery lab | Actual independent bucket/key custody, archive schedule/alerts and measured off-host restore |
| Remote management | Concrete generator for router-initiated WireGuard to a public hub, with owner-only Tailscale access to the router's `/32` management address | No public host or authenticated Tailscale environment has been selected; no tunnel, route or access grant is active |
| Help | Reviewed public FAQ, local UI filtering and bounded read-only API search | No model or authority to alter accounts, payments, allowances or routers |

The authoritative capability response controls what the UI offers. A queued bundle, prepared checkout, submitted SMS, prepared network credential and requested disconnect each remain distinct from their confirmed outcome. Real payment, delivery and network flags default to disabled.

## Verification records

The latest completed expanded strict run recorded **126 passing tests, zero skipped**: identity 26, prepaid 41, network 6, notification 14, assistant 4, web 29 and mobile 6. It included the real three-browser journey from administrator MFA through new-agent application/MFA/approval, site stock allocation, agent sale, customer private receipt and voucher redemption. All seven independent builds passed.

A subsequent staff UI review found that a delayed session response could restore an old view after a cross-tab sign-out. Generation guards now invalidate old initial/refresh/MFA responses, expiry, logout and unmount. Both held-response regressions pass. A further targeted retry correction adds server-fenced expired-unused quote closure in both customer clients and unlocks agent sale correction only after a serialized rollback. The current workspace suite passes 13/13 and mobile passes 7/7; both frontend builds pass. The next full strict run must record these additional cases and backend regression additions before that final source revision is treated as accepted; focused counts are not summed into a new full-run total.

The current mobile suite comprises two offline phone-layout journeys and five configured HTTPS API mock cases, including preservation of an unresolved payment intent. Android/iOS Capacitor synchronization passed in disposable native-project copies. Native CI separately produced an API-unconfigured Android debug APK and an unsigned iOS simulator app with Xcode 26.6 for arm64 and x86_64; both jobs succeeded in workflow 41373579356. See the dated workflow record in [the review](REVIEW_2026-11-02.md) and [native build notes](../../pamofi-frontend/mobile/NATIVE_BUILDS.md). Native compilation does not enable mobile account access or certify device behavior.

The strict runner refuses missing isolated databases, skipped database cases, skipped/flaky browser cases and unexpected service exits. CI also runs the real FreeRADIUS packet, encrypted physical backup/restore and private-staging container labs. Use the exact workflow result for the exact source revision, not an earlier green run.

## First physical router and remote access

The read-only [first-router inspection](../pamofi-routeros/site-01/INSPECTION.md) found a hAP lite, SMIPS, 32 MiB RAM, RouterOS 7.18.2, no HotSpot/RADIUS servers and disabled HTTPS management. Existing home LAN/wireless service was preserved. No paying-client capacity was inferred from the inspection.

The owner confirmed no always-on device at the site. The [remote-management design](../infra/remote-access/README.md) therefore uses native router WireGuard to a public server and Tailscale on that server for the owner's narrow management route. The source generator prepares reviewable configuration; it performs no remote activation. A selected authenticated host, non-overlapping addresses, verified owner identity, exact firewall rules and a tested recovery path are still required.

## Remaining external and operational work

1. Select and authenticate the public host, domain and release images; provision trusted public/private certificates and independent production secrets. Validate gateway routes, restricted runtime roles, egress and observability on that host.
2. Enroll actual staff and authenticators, set approved sites/catalogue/commission policy, and confirm provider merchant methods, limits, fees, sender identities and permissions. Qualification flags are records of completed acceptance, not substitutes for it.
3. Establish the private management path, then configure the isolated customer HotSpot network without replacing the existing management LAN. Test physical byte/time enforcement, both usage directions, IPv6/FastTrack bypass prevention, simultaneous/cross-site sessions, reboot, loss/reordering, verified disconnect and measured capacity.
4. Configure independent encrypted off-server backups and continuous WAL archiving, key custody, scheduling and alert delivery. Restore on another host, fence the old authority and measure actual recovery point/time.
5. Qualify native customer cookies and exact app origins with the gateway, then test physical devices, captive/system browser transitions, payment returns, offline/retry/recovery and accessibility. Owner signing and store distribution remain separate from unsigned CI compilation.
6. Exercise production monitoring, operator review/refund/resend procedures, encryption-key rotation, load, release rollback and incident recovery. Verify any proposed operating policy against the actual provider, host and device evidence.

## Existing deployment records

Earlier notes record a labelled Vercel preview and private Oracle staging VM. This source work does not establish that either running environment has this revision. The checked-in Vercel configuration has no public backend connection; private staging exposes no public service or customer network authority. Source publication, native artifacts and passing CI do not deploy a public service or enable live providers/router access.
