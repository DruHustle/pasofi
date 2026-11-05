# Principal Engineer backend review — 5 November 2026

Reviewed main `7be0dfd` and the resulting lifecycle correction in the isolated
review worktree. This was a source and targeted local-test review; no production
records, credentials, launch gates or infrastructure were changed.

## Confirmed finding and correction

**P2 — Pausing new connections also blocked customers from inspecting or stopping
an existing paid session.** `network-lifecycle.ts` applied the issuance capability
check to `GET /v1/network/session` and `POST /v1/network/disconnect`. With
`PAMOFI_CUSTOMER_NETWORK_ENABLED=false`, both returned `404 network_disabled`
before authentication or a ledger query. A router session could continue to
consume allowance, while its customer lost the application control to stop it.

The two existing-session operations now depend on the ledger and authenticated
customer identity. Disconnect still requires the approved request origin and an
owning-customer match in the SQL update; it reports `disconnect_pending` until
router reconciliation independently establishes termination. New site discovery
and credential issuance remain behind the original capability checks. No
additional router or administrative privileges are granted.

Validation: TypeScript build passed. Seven targeted tests passed without skips
against a new disposable PostgreSQL 17.11 instance and HTTP route fixtures.
They cover own versus another customer's grant, unauthenticated and cross-origin
requests, paused issuance, unavailable ledger, pending termination, final Stop
and independent absence, NAS restart/missing Stop, regressing counters, replay,
and contradictory late usage. The test database/container was removed afterward.

## Scope and retained safeguards

The review inspected customer/staff sessions, recovery and MFA, staff approval
and scope resolution, cash references and sales, voucher redemption, refunds and
shift locking, entitlement reservations and RADIUS accounting, reconciliation,
the dedicated portal proxy, and production backup scripts. Existing controls
include server-priced immutable sale terms, transaction/idempotency locks,
hashed opaque session credentials, staff-version fencing and MFA, exact origin
checks, bounded quota reservations, and independent absence before a final
allowance release. No additional confirmed software defect was found within
this scope. This is not a claim that every path or deployment configuration has
been independently exercised.

The NAS `enabled` flag rejects both new authentication and accounting from that
NAS. Keep that revocation behavior; planned maintenance must drain/reconcile
active sessions before disabling NAS trust. Changing this to accept accounting
from a revoked NAS would require a separate trust-policy decision.

## Launch evidence still required

The physical router restart and memory/service-malfunction evidence remains a
launch blocker independent of this patch. Positive paid RouterOS login,
Start/interim/Stop accounting, actual byte/time exhaustion, disconnect and
reconnect, and site isolation must be commissioned on the real devices before
opening customer sales. RouterOS upload/download direction should be checked
against an asymmetric real transfer because the vendor's RADIUS documentation
contains conflicting directional descriptions; aggregate quota accounting sums
both directions and is not changed by this review.
