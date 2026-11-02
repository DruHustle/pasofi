# Build status — 2 November 2026

**Development foundation with simulated customer journeys and isolated infrastructure laboratories. Not ready for live prepaid Wi-Fi sales.**

This is the current capability summary. Earlier incremental build notes are preserved in Git history; they should not be used as a description of the current code. The review baseline was `d513eeec36f84c6cba6c8dd3f7168336ae3954d2`.

## Implemented and tested in source

| Area | Current behavior | Boundary |
| --- | --- | --- |
| Independent projects | Five Fastify/TypeScript services, separate databases/roles, web React/Vite application and independent Capacitor mobile preview | Production migration/runtime privilege separation is unfinished |
| Catalogue | PostgreSQL-backed published bundle versions, exact integer prices and string byte limits | Candidate prices; private staging remains unpublished |
| Customer identity | Origin-checked HttpOnly sessions, scoped resolution, lost-response creation retries, versioned recovery, current-session logout | No staff/MFA or verified-phone identity |
| Web customer journey | Simulated purchase, queued access, recovery in another browser, sign-out, retry and failure states | No real checkout or hotspot connection |
| Financial authority | Transactional orders/payments, source-specific fulfillment, duplicate-charge review, reversal handling, durable provider verification queue | Merchant/provider qualification and operational refund workflows remain unfinished |
| Agent and vouchers | Stock debit, immutable sale terms, encrypted random voucher, atomic redemption/replacement and outbox domain functions | No authorized agent UI, private paired receipt or customer redemption HTTP flow |
| Access authority | FIFO selection, per-customer reservation, NAS/session binding, duplicate-safe cumulative upload/download accounting | Verified termination, release/reconciliation and physical router behavior are unfinished |
| Network laboratory | Scoped service tokens, mutual TLS, registered NAS mapping, temporary encrypted credentials, two-site exclusion | Explicitly demo-only; no production enablement or real-router acceptance |
| Notification | Transactional inbox/deduplication, attempt ledger, known-ID status polling, ambiguous-send protection | Secure delivery lookup, staff-authorized resend and live handset qualification remain unfinished |
| Help | Reviewed public FAQ, local UI search, bounded API search, explicit unsupported answers | No model, personal account access, payment or router action |
| Operations | Serialized checksum-verified migrations, bounded readiness probes, idle-connection recovery, graceful shutdown, strict verification runner | Full production monitoring, key rotation, capacity and rollback acceptance remain unfinished |

## Refinements in this review

- Browser retries keep the same order idempotency key across an interrupted response or reload. Confirmed orders clear their retry state without blocking the next purchase.
- Missing/expired sessions no longer silently create a replacement account when viewing access. Sensitive actions verify the original customer.
- Recovery verifies the new cookie; interrupted rotation hides the obsolete key and reloads the current version.
- Logout revokes the current session and its retry-secret mapping. Successful UI sign-out clears only PamoFi session secrets.
- Repeated and out-of-order payment observations preserve pending review and reversals. An unexpected provider state cannot grant access.
- Known Pesepay references survive an unsafe checkout redirect, and known SMS IDs survive malformed optional metadata. Verification can continue without a second charge or send.
- Current access remains visible ahead of historical entries; history has bounded pagination.
- The nginx proxy forwards all supported customer APIs and refuses unknown/internal API paths.
- All service pools handle idle PostgreSQL errors. Service readiness is now checked by Compose; startup helpers wait for it.
- The mobile build's vulnerable transitive glob/minimatch chain is overridden narrowly while Capacitor stays at 8.6.0.
- Documentation, reviewed help, responsive states and accessibility have been updated to match implemented behavior.

See [the review record](REVIEW_2026-11-02.md) for findings and verification details, and [TESTING.md](TESTING.md) for reproduction.

## Verification levels

Unit builds, real PostgreSQL integration tests and Chromium journeys are separate checks. The strict runner refuses missing test databases, skipped database tests, skipped/flaky browser cases and unexpected service exits. It uses synthetic data and provider mocks only.

The CI workflow repeats the source checks with PostgreSQL 17.11, then runs the existing real FreeRADIUS packet, encrypted physical backup/restore, and private-staging container laboratories. Consult the pull request's actual workflow result before treating those container checks as passed for this revision.

The mobile browser suite exercises the offline preview. Successful Capacitor Android/iOS synchronization is not native compilation or device acceptance.

## Remaining implementation and launch work

1. **Staff and agent access:** staff identities, role assignment, MFA, authorization, audited administration and complete agent sale journeys.
2. **Customer voucher/receipt flows:** private pairing, QR/session handoff, authorized voucher delivery, customer redemption and safe recovery across captive/system browsers.
3. **Payment and SMS operation:** configured merchant methods and limits, provider sandbox evidence, secure delivery payload lookup, delivery/resend policies and operator review/refund workflows.
4. **Complete network lifecycle:** trusted disconnect and final accounting reconciliation, reservation release, reboot/reordering recovery, production credentials/tunnels and physical MikroTik enforcement tests across sites.
5. **Production operations:** secure public API/HTTPS, trusted internal transport and secret rotation, runtime/migration role separation, monitoring, capacity testing, controlled releases and rollback.
6. **Independent recovery:** encrypted off-server PostgreSQL/pgBackRest repository, continuous WAL archiving, scheduled retention/alerts, independent key protection and tested full recovery/fencing. The disposable local backup lab does not configure B2 or protect staging data.
7. **Native customer application:** connect the independent mobile preview to qualified customer APIs, then build and test signed Android/iOS applications on devices.

These are explicit unfinished product/release capabilities, not green tests or enabled features. No staff, merchant, SMS, router or independent-backup credentials are supplied by this source review.

## Deployment records

Earlier source notes record a labelled Vercel frontend preview and a dedicated private Oracle staging VM. This review has not inspected those running environments. The repository's Vercel configuration has no public backend connection; the staging Compose stack has no public ports, published bundles, mock payments or live RADIUS authority. Source changes and a passing pull request do not by themselves deploy either environment.
