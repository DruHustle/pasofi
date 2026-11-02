# Architecture

PamoFi separates browser applications from independently deployable backend services. Web and mobile have their own dependencies and builds. Backend services communicate through scoped APIs and events; they do not import each other's code or query each other's operational databases.

## Service boundaries

| Service | Owns | Implemented boundary |
| --- | --- | --- |
| Identity | Customers, sessions, session-creation retries, recovery | HttpOnly cookie sessions, same-origin mutations, scoped internal resolution, versioned recovery and current-session logout |
| Prepaid access | Catalogue, orders, payments, agent inventory, vouchers, entitlements, grants, accounting, outbox | Sole money and allowance authority; transactions and concurrency tests protect state changes |
| Network | Registered NAS records, temporary credentials, RADIUS adapter | Private lab adapter authenticates FreeRADIUS with mutual TLS and asks prepaid access for authorization |
| Notification | Event inbox, delivery jobs, provider evidence | Deduplicated ingestion and SMS attempt ledger; secure delivery lookup and operational sending remain unfinished |
| Assistant | Reviewed public help | Read-only FAQ and bounded search; no model, customer credentials, payment actions or router access |

One PostgreSQL instance may host five databases, with separate roles. Demo and staging initialization revoke public access to service databases. Production still requires separate runtime/migration privileges and operational recovery controls.

## Customer flow

Identity creates a session with a short-lived client retry secret. A lost first response can be retried without creating another customer. The browser confirms the cookie is usable before continuing.

Prepaid resolves the customer through identity using a short-lived service token. It snapshots terms into an order and binds the idempotency key to that customer and payload. Demo confirmation creates one mock payment and queued entitlement transactionally. The browser preserves a pending purchase across an interrupted response and reload.

Recovery requires an account reference and high-entropy key; only its verifier is stored. Rotation is versioned. An ambiguous response must not leave the old key displayed as valid. Logout revokes the current session and its creation-retry record without changing other sessions or the ledger.

## Access enforcement boundary

The intended rule is one active connection per customer across all sites. The lab reserves an entitlement before authorization and binds it to the NAS and accounting session. Validity starts on verified accounting Start. Upload and download counters are cumulative; duplicates do not charge twice. Ambiguous or regressing counters retain an uncertain reservation.

A Stop packet alone does not release a reservation. Verified termination, final accounting reconciliation, router reboot handling and physical enforcement remain release blockers. Lab authority cannot be enabled in production.

## Payment and delivery evidence

A browser redirect or callback does not prove payment. Server reconciliation must match provider reference, application, currency and amount. Repeated and out-of-order responses preserve review/reversal state. A known reference survives an unusable checkout redirect so verification can continue without another payment initiation.

Prepaid outbox and notification inbox provide durable deduplication. SMS acceptance is distinct from delivery. A known message ID survives malformed optional metadata so status lookup remains possible; ambiguous submission is not automatically resent.

## Configuration and tests

Demo, staging and production behavior are explicit. The web proxy allowlists customer routes; internal endpoints are not forwarded. No production credentials are needed for testing. See [TESTING.md](TESTING.md), the service OpenAPI files and [BUILD_STATUS.md](BUILD_STATUS.md).

Successful source or laboratory tests do not establish live provider, router, native-store or infrastructure acceptance.
