# Pricing assumptions

## Owner-requested catalogue revision — 5 November 2026

The owner requested **USD 10 for 100 GB** and corresponding adjustments to the
other bundles. The revised plan uses the same USD 0.10 per decimal GB across the
five price points and retains the existing validity periods:

| Bundle | Price | Data | Validity |
| --- | ---: | ---: | ---: |
| Mini | USD 0.50 | 5 GB | 3 days |
| Flex | USD 1.00 | 10 GB | 7 days |
| Week | USD 3.00 | 30 GB | 7 days |
| Fortnight | USD 5.00 | 50 GB | 14 days |
| Month | USD 10.00 | 100 GB | 30 days |

One GB is 1,000,000,000 bytes. These are selling terms, not a claim of
profitability or the lowest market price. A frontend release does not publish
the database catalogue. An authenticated, approved administrator must review
and apply the plan in the staff catalogue. The existing MFA, actor-version,
origin and server-side authorization checks continue to apply while sales are
paused.

Deploy the prepaid service update that advertises `publicationGuardVersion: 1`
on `GET /v1/admin/bundles` before using the one-click revision. The frontend
disables that action and the controller refuses every write until this support
is present. Each older-offer withdrawal sends all five replacement IDs. The
service locks the target and replacements in deterministic order, checks that
the replacements remain published, and commits the withdrawal and its audit
in the same transaction. A concurrent replacement withdrawal returns a conflict
and leaves the older offer available for review.

Each replacement is a new immutable bundle version. Prepare the replacement
drafts, publish and verify them, then withdraw only the superseded offers whose
recorded terms match the expected prior catalogue. Keep old versions, receipts,
orders, vouchers and allowances intact. If a request has an uncertain outcome,
reload the authoritative catalogue and reconcile the same version IDs before
retrying. Never overwrite an existing version with different terms, withdraw
unrelated offers or silently repurpose stock allocated to an older version.
Allocate new-version stock explicitly to approved agents and assigned sites
before opening sales. Verify the public catalogue and receipt terms after the
change. Publication does not enable sales, payments or hotspot access.

The historical demo seed retains its original candidate catalogue so existing
fixtures and restored demonstrations remain reproducible. It is not the current
production price authority; the published database versions are authoritative.

## Operating assumptions

The reported US$30/month Home/Residential Lite cost is unverified and cannot be
assumed for both sites or treated as authorization for commercial use. Obtain
site-specific plan, invoiced costs and permission before launch.

The owner has excluded Pesepay and selected a direct-provider/bank integration direction. Do not carry over an aggregator's published minimums or fees as the terms of a direct merchant contract. EcoCash, InnBucks and the selected acquiring bank must each confirm current currencies, minimum/maximum amounts, fixed and percentage fees, settlement and refund terms. See the dated [direct payment investigation](PAYMENT_INTEGRATION_RESEARCH_2026-11-02.md). Live digital checkout remains unavailable; the current sales path records exact cash confirmed by an authorized agent.

Keep current market comparisons, tax, approved commissions and actual network
capacity separate from the owner-selected selling prices. For small bundles,
model fixed payment costs separately from agent commission and bandwidth costs.
A software test price is not evidence of commercial viability.
