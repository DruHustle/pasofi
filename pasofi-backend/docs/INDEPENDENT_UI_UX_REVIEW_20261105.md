# Independent Senior UI/UX Engineering review — 2026-11-05

Reviewed the PasoFi customer, hotspot connection, cash receipt, voucher, account recovery and staff onboarding flows against the requested compact blue/white/lime direction. Graphic styling was reviewed independently by the graphic-design reviewer; this review focuses on recoverability, understandable state, accessible feedback and safe customer actions. Review base: `7be0dfd`.

## Findings and resolution

| Priority | Finding and customer impact | Resolution |
| --- | --- | --- |
| High | A failed hotspot-location read left an empty selector and disabled connection action without a retry. The existing connection refresh only checked usage, so it could not repair the location list. | Added distinct loading, failed and empty states with a location retry. Metadata responses are checked before display, cancelled when obsolete, and do not issue credentials. Web/mobile `src/NetworkAccess.tsx`. |
| High | A failed purchase-location or bundle read left cash/checkout choices empty without a recovery action. Leaving the workflow could confuse customers who already had a saved purchase. | Added a purchase-options retry, loading/error/empty feedback, and disabled new requests until choices load. Existing ambiguous purchases and selected bundles remain preserved. Web/mobile `src/CustomerAccess.tsx`. |
| High | Turning off new network access also hid current-session information and disconnect controls. Existing paying customers could lose their way to check or stop a session during a pause. | Current-session status and disconnect remain available. New-connection UI and prepared credentials require the positive issuance capability. Capability changes clear local credentials and pending UI state; generation checks fence obsolete responses. The Principal Engineer made the matching backend lifecycle change. |
| Medium | Connection status used internal terms such as grant deadline and reconciliation. | Replaced those terms with plain connection language while retaining the distinction between prepared credentials and router-confirmed connectivity. |
| Owner content required | Public terms/privacy pages still explicitly say they will be finalized before launch. The reviewed repository contains no complete approved commercial policy set. | Recorded the decisions below for owner review. No refund promises, retention periods or legal terms were invented. |

Loading and state feedback uses status regions; actionable failures use alerts and visible retry buttons. The changes preserve native labelled controls and the existing keyboard interaction. This is a targeted engineering review, not a complete WCAG certification.

## Verification

- Web and mobile TypeScript/Vite production builds passed.
- Combined `usage.spec.ts`, `workspaces.spec.ts` and the new recovery tests: 43 tests passed. This includes staff registration/MFA/approval, cash pairing and receipt redemption, saved checkout and sale recovery, ownership fences, private credentials and usage refresh.
- Final `ux-recovery-review.spec.ts`: all six tests passed after the final lifecycle cleanup. Covers failed and empty hotspot locations, failed sites and bundles during cash purchase, paused issuance with no session, and paused issuance with an active session that can disconnect.
- Browser assertions used local mocked API responses. They do not constitute real-router accounting/quota commissioning or proof of production payment readiness.

## Commercial information requiring owner decisions

The reviewed implementation establishes these facts: bundles carry a published price, currency, allowance and validity; cash sales preserve the quoted values; validity starts on verified router accounting Start; upload and download count toward the allowance; the purchase has a start-by date; the receipt workflow requires the agent to attest to the cash actually received. Supervisor-controlled refund software supports an unused full refund with review, and retains original sale evidence. These mechanisms do not by themselves define the customer refund policy.

Sources include `docs/AGENT_CASH_WORKFLOW.md`, `services/prepaid-access-service/src/vouchers.ts`, `payments.ts`, and the customer receipt/connection UI. Existing `docs/PRODUCTION_COMPLETION_2026-11-02.md` and `docs/UI_UX_REVIEW_2026-11-02.md` also identify the missing approved trust content.

The owner needs to settle:

1. The contracting entity, business address and applicable sales jurisdiction.
2. Refund eligibility and time limits, treatment of used data and service interruptions, and the complaint process.
3. Whether displayed prices include any applicable taxes.
4. Customer support hours and any promised response or escalation times.
5. Privacy contact, approved data retention/deletion rules and relevant service-provider disclosures.

Code stores customer identity/session, purchase, network/accounting and audit records; staff accounts also include identity and MFA information, and optional receipt delivery can use a phone number. A session expiry is not a data-retention policy. Append-only audit permissions do not establish an approved legal retention period. Publish approved service/privacy information before treating these pages as complete customer-facing launch material.
