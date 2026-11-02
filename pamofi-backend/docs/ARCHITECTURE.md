# Architecture

PamoFi separates its independent web and mobile applications from five independently deployable backend services. Each project owns its dependencies and build. Services communicate through scoped APIs and reference-only events; application code never imports another service's implementation or queries its operational database.

## Service boundaries

| Service | Owns | Implemented boundary |
| --- | --- | --- |
| Identity | Customer sessions/recovery/handoff, staff password/MFA/roles/scopes, approval audit | HttpOnly cookies, exact-origin mutations, scoped internal resolution, versioned decisions and revocation |
| Prepaid access | Catalogue, orders/charges, sites, agent stock/sales, vouchers/receipts, entitlements/grants/accounting, outbox | Sole money and allowance authority; current identity resolution and transactional authorization protect every mutation |
| Network | Registered NAS records, temporary credentials, RADIUS adapter, router observations | Scoped private calls, mutual-TLS RADIUS boundary and controlled HTTPS RouterOS lookup/disconnect/re-query |
| Notification | Event inbox, delivery jobs/leases, submission and provider evidence | Authenticated delivery lookup, idempotent jobs/resends, polling of known references and no automatic ambiguous resend |
| Assistant | Reviewed public help | Read-only FAQ/search with no model, personal account authority or router/payment action |

One PostgreSQL cluster may host all five databases. The [production foundation](../infra/production/README.md) defines a non-login owner, separate migration login and narrowly granted runtime login for each database. Migration checksums and reviewed grant manifests fail on unreviewed changes. Demo credentials and privilege choices remain separate from that production configuration.

## Selected hosting and site topology

The selected topology places the web frontend on Vercel and backend services/databases on Oracle. The web app keeps same-origin `/api` requests; a server-only proxy forwards the reviewed public routes to an authenticated Oracle HTTPS gateway. The gateway's hostname and the allowed browser origin are separate settings. Only authenticated proxy metadata can establish the original client IP for service rate limits. Neither browser code nor public routing exposes internal service credentials or endpoints.

At each site, Starlink is upstream of the MikroTik. The MikroTik initiates the private WireGuard service connection to Oracle, allowing operation behind Starlink's default CGNAT. That connection carries only RADIUS authentication/accounting, scoped HTTPS management and reviewed diagnostics. Customer browsing follows the normal Starlink internet route. Owner remote management has its own access policy; it does not substitute for the permanent backend/site connection.

Software laboratories validate both the Vercel/Oracle boundary and production RADIUS package. Actual cloud identities, DNS/TLS, protected secrets and physical hotspot acceptance remain deployment inputs; see [HOSTING.md](HOSTING.md).

## Customer and agent flow

Identity creates a customer session using a short-lived client retry secret. A lost first response can be retried without creating another customer, and the client verifies that the cookie is usable before proceeding. Recovery uses a reference and high-entropy key; rotation is versioned. Browser handoff uses a separately pasted, single-use two-minute code and explicit consent, never a credential in a URL. Logout revokes the current session and creation retry mapping without changing other sessions or ledger records.

An agent has an approved MFA-verified identity and assigned sites. Administrators allocate published bundle inventory. A new cash sale requires the agent's explicit attestation of the exact price and currency. The server records that agent and time, snapshots terms and commission, atomically debits stock, issues the encrypted voucher, consumes any private customer pairing and appends an outbox event. An ambiguous response is retried with the same owner-scoped key and exact payload; historical tender evidence remains explicitly unrecorded. Only the paired customer can read a private receipt and redeem its voucher. Redemption creates queued access; it neither starts validity nor establishes a connection. See [the cash workflow](AGENT_CASH_WORKFLOW.md).

Digital payment authority uses immutable orders, durable initiation/reconciliation identity and exactly-once fulfillment. The owner has excluded Pesepay; current integration work targets direct providers and a selected bank. No live digital checkout is enabled. The customer's UI reflects authoritative fulfillment, reversal or review status. A return URL or callback is only a hint; qualified provider verification must establish the reference, merchant, currency and amount. Duplicate or out-of-order observations cannot create duplicate entitlement or erase a reversal/review. See [the direct integration investigation](PAYMENT_INTEGRATION_RESEARCH_2026-11-02.md) for the documented EcoCash settlement gap and the merchant contracts still required.

## Access lifecycle

Prepaid reserves an entitlement before authorization and binds it to the customer, site, NAS, credential generation and accounting session. The database enforces one live reservation per customer. Validity starts on verified accounting Start. Upload and download counters are cumulative; duplicate accounting does not charge twice, while regression or ambiguous evidence retains an uncertain reservation/hold.

The authenticated usage endpoint reads allowance, accounted consumption, current grant and hold in one SQL statement snapshot, with a two-second transaction-local timeout. Totals cover all eligible entitlements rather than the paginated history. Web/mobile customer views poll every five seconds while active, display active and queued allowance separately and distinguish ledger refresh time from the last received router report. The requested router accounting interval is 60 seconds. Outstanding reservations are separate from recorded consumption and never deducted twice; an expired or revoked entitlement may still have an unresolved reservation.

The customer requests credentials and disconnect through prepaid's public boundary. Network revokes the matching credential and queries the exact generated username on the registered router. It deletes only matched session IDs and independently queries again. A successful DELETE or Stop alone is insufficient to release a reservation: final usage, fresh independent absence and credential fencing must agree. Lost Stop, reboot or late higher usage remains blocked for evidence-based reconciliation. The admin review accepts exact cumulative counters with version, reason and evidence; it does not invent unknown usage or write off balances.

Software tests use a local HTTPS RouterOS fake and real FreeRADIUS packets. The production qualification gates stay disabled until physical sites and their private transport have passed the required enforcement and failure tests.

## Delivery and frontend boundaries

Prepaid emits reference-only events; no phone number or voucher enters the outbox payload. Notification retrieves transient encrypted delivery details through authenticated service calls. Submission and delivery remain distinct. A known provider ID survives malformed optional metadata so polling can continue. An unknown outcome cannot trigger an automatic resend. Agent/admin resend is explicitly authorized, reasoned, idempotent and tied to the saved recipient; support sees sanitized scoped evidence only.

The web gateway and Vite proxy allow only the reviewed public customer/staff/admin routes. Browser code never calls internal authority or provider callbacks. Cross-tab changes and action-time owner/version checks prevent stale sessions from authorizing another account's work. Async staff generation checks also prevent delayed initial or post-MFA responses from restoring a cleared account view.

The independent mobile client accepts only a configured HTTPS origin, credentialed CORS and the deployment's explicit qualified-cookie capability. It offers an offline preview otherwise. The current service returns `mobileCookies: false`; compiled native packages do not establish native authentication qualification.

See [TESTING.md](TESTING.md), the service OpenAPI files and [BUILD_STATUS.md](BUILD_STATUS.md) for evidence and remaining deployment/provider/router/device boundaries.
