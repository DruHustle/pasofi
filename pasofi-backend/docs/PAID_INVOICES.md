# PasoFi paid invoices

## What this release adds

Every new recorded cash payment and every fulfilled, provider-verified digital payment receives an immutable paid invoice. The invoice is issued in the same transaction as the authoritative payment fulfillment, and a retry returns the existing invoice. Draft quotes, pending payments, browser redirects and unverified callbacks cannot create a paid invoice. No historical payment is invented or backfilled by the migration.

The PDF records the invoice number, issuer, issue/payment time, bundle, currency and exact paid amount, payment method/evidence and source reference. A demo invoice is conspicuously marked as a simulation. Once issued, its saved PDF bytes and source snapshot cannot be changed by the runtime role. Refunds/reversals remain separate records; the original invoice is not rewritten. Number allocation can have gaps after rolled-back transactions and must never be reset.

This is an ordinary commercial payment record, labelled **not a ZIMRA fiscal tax invoice**. No VAT number, rate, fiscal signature or FDMS QR code is invented. Zimbabwe fiscalisation obligations must be handled through the business's qualified fiscal device/FDMS integration; a PDF generator alone does not meet them. See [ZIMRA fiscalisation guidance](https://www.zimra.co.zw/domestic-taxes/corporate/fiscalisation-explained).

## Customer and staff flow

The compact **Invoice copy** field appears alongside payment details. Email and SMS choices appear only when the backend advertises a configured channel. Choose the channel and check the recipient before creating the order or recording the cash sale; it is part of that request's immutable retry payload. **Download PDF** remains available from the resulting receipt and paid-invoice history.

- Email sends the exact saved PDF as an attachment.
- SMS sends a private HTTPS link to that PDF. Ordinary SMS does not carry a PDF attachment. The link expires seven days after invoice issuance, and the SMS includes its actual UTC expiry.
- Download-only records need no notification provider. Customers can save their PDF themselves, and authorized staff can help an unpaired cash buyer.

Invoice history starts collapsed and uses compact rows. Recipient input appears only for the selected channel. On the native app, an explicit **Share PDF** action writes a short-lived copy to app cache and opens the system share sheet; old cached exports are removed on a later launch/export. Browser downloads use the same saved PDF.

## Read and download boundary

Customers can list/read only their own invoices, including a cash invoice linked through pairing or redemption of that sale's voucher. Agents can read only invoices from their own sales at a currently assigned site. Admins can read staff invoices; support is not given invoice access. Reads stay available when sales gates are paused.

Public routes are `GET /api/customer/invoices`, `GET /api/staff/invoices`, their `/:id` detail and `/:id/pdf` downloads. Lists are paginated and support `saleId`/`orderId` filtering. PDF responses are private, no-store attachments. The Vercel proxy accepts a bounded real PDF only on the exact invoice download routes; other API responses remain JSON.

For SMS, a 256-bit random bearer is placed in the link fragment, removed from the visible URL when opened and submitted in a POST body to `/api/invoice-downloads`. The database stores its hash plus an encrypted copy in the invoice delivery intent. The bearer authorizes only that PDF, never the account or another purchase. Anyone holding an unexpired link can download its invoice: recipients should keep it private. A customer who loses or outlives the link can use their authenticated invoice history, or ask an authorized sales agent for the saved PDF.

Email addresses/phone numbers are encrypted at rest using the existing versioned delivery key ring. Keep historical keys available while stored records still need them. Event and notification job payloads contain references only. PDFs do not embed voucher or network credentials.

## Free service findings — checked 5 November 2026

| Service | Published free allowance | Use in this release |
| --- | --- | --- |
| [Resend](https://resend.com/pricing?product=transactional) | 3,000 transactional emails/month; 100/day. Verify a sender domain. | Implemented HTTPS email attachment adapter; disabled until explicitly qualified. |
| [Textbelt](https://www.textbelt.com/) | Public `textbelt` key allows one free SMS/day. Its [country list](https://docs.textbelt.com/supported-countries) includes Zimbabwe, subject to country/use-case requirements. | A limited test option, not the app's business SMS transport. No customer number was submitted during this research. |
| [SMS Gateway for Android](https://docs.sms-gate.app/pricing/) | Free/open-source gateway software using a phone/SIM. | Not integrated. Carrier SMS charges, permitted business use and a powered/connected phone still need separate arrangements. |

Email is the practical free starting point within its quota. This release reuses the app's qualified Sendai adapter for optional paid SMS. It does not label a trial, self-hosted phone or carrier transport as unlimited free messaging.

## Configure email after the application rollout

1. Sign in to the business's Resend account. Verify the actual sender domain using the DNS records Resend supplies. Do not assume an old verification is current. [Sender-domain instructions](https://resend.com/docs/dashboard/domains/introduction).
2. Choose a verified invoice sender. `PasoFi <notifications-pasofi@onesa.eu>` is suitable only if that exact sending domain is verified in the account. A dedicated verified subdomain is also possible.
3. Create a dedicated protected server-side Resend API key. This polling implementation requires Resend's **Full access** permission: the provider's **Sending access** key cannot retrieve delivery status. [Permission reference](https://resend.com/docs/api-reference/api-keys/create-api-key). Keep the key out of the browser, source code, chat and command history. Store it as the existing protected secret directory's `resend_api_key`, readable only by the deployment administrator/runtime secret mechanism. The production entrypoint reads it through `RESEND_API_KEY_FILE`.
4. Provision a separately restricted provider egress network for notification's HTTPS calls to `api.resend.com`. The application service/database networks remain internal. Use the host's approved firewall/DNS process; merely creating an unrestricted Docker network is not the same as restricting egress.
5. Add `infra/production/invoice-delivery.compose.yaml` to the **complete existing overlay list**. Set the non-secret values `PAMOFI_INVOICE_EGRESS_NETWORK`, `PAMOFI_INVOICE_EMAIL_FROM`, `PAMOFI_INVOICE_DELIVERY_ENABLED` and `PAMOFI_INVOICE_EMAIL_QUALIFIED` explicitly in the protected deployment environment. The qualification value must represent a completed sender and operator-owned delivery test, not an assumed capability.
6. Render/review the complete configuration privately. Preserve current secrets, database volume, gateway/RADIUS configuration and all unrelated sales/payment/network flags. Apply only the reviewed notification/gateway configuration. Use the deployment package's supported configuration workflow; do not remove other overlays.
7. Check `/api/capabilities`: `invoices` confirms invoice support, while `invoiceEmail` becomes true only after the outbox, encryption keys and notification channel are configured. `invoiceSms` is independent.
8. Perform an operator-owned end-to-end acceptance purchase in the isolated environment first, and then a controlled authorized live purchase. Check that the PDF arrives, the invoice number/amount match and status changes from submitted to delivered only with provider evidence. Confirm failed delivery still leaves the original downloadable invoice. Qualification purchases and real deliveries are operator actions, not part of automated CI.

For an initial provider qualification, send a clearly marked synthetic PDF to an operator-owned mailbox directly from the provider's supported tooling, verify receipt and retrieval permissions, then enable the app channel and complete its end-to-end acceptance. No real customer payment is needed merely to qualify the sender.

Resend free-plan quotas apply to all relevant account traffic. A 429 rate rejection is queued for retry; it does not show as delivered. Ambiguous send outcomes require operator investigation and are not automatically resubmitted. The adapter's [stable idempotency key](https://resend.com/docs/dashboard/emails/idempotency-keys) supplements, rather than replaces, the durable no-double-send rules.

This HTTPS invoice adapter is separate from the existing staff password-reset SMTP configuration. Do not enable or relax staff-recovery flags as a side effect of invoice setup.

## Optional SMS qualification

Use `invoice-sms.compose.yaml` only with the actual approved provider account, a registered sender, allowed invoice-link content and successful destination-network tests. Configure `PAMOFI_INVOICE_SMS_FROM`, `PAMOFI_INVOICE_SMS_QUALIFIED`, `PAMOFI_SENDAI_LIVE_ENABLED`, `PAMOFI_SENDAI_QUALIFIED`, the protected `sendai_api_key` secret and approved provider egress. This enables invoice SMS only when the worker is enabled; it does not enable voucher SMS, payments or sales by itself. A long SMS may consume multiple message segments and credits.

## Deployment and operations

Apply prepaid migration `030_paid_invoices.sql` and notification migration `005_paid_invoice_delivery.sql` with their migration owners, then apply the reviewed runtime grants. Runtime gets SELECT/INSERT only on invoice records and USAGE/SELECT only on the invoice sequence. The notification worker can update delivery job state but cannot alter invoice content. New gateway rules and frontend builds are required for downloads.

The deployment package defaults to inspection/preflight. It uses the existing Compose project, all existing overlays, protected secrets and persistent database volume. It builds the qualified pinned release, runs owned migrations and replaces only the intended application containers. It never uses `docker compose down`, volume deletion or `--remove-orphans`. Its rollback record is private; a schema rollback or database restore is a separate recovery operation.

Run the existing operations diagnostic with `--queues` after rollout. Investigate `invoice_ambiguous`, `invoice_failed` and `invoice_delayed`. Do not report a queued/submitted invoice as delivered or reset an unknown job to queued just to clear a warning. The same PDF is always the safe customer fallback.

Automated qualification covers payment-only issuance, immutable retries, ownership/site access, bearer expiry/origin, private lookup scope, outbox/inbox deduplication, exact attachment bytes, mock delivery, ambiguity/crash recovery, narrow gateway PDF forwarding, compact UI and native builds. Actual provider receipts, a real server rollout and physical hotspot acceptance must be evidenced separately.
