# Agent cash sales and customer usage

## Intended outcome

A customer pays an approved agent the published cash price, receives a private voucher receipt, redeems it into their own account and sees the queued allowance. After a successful hotspot connection, the customer sees recorded usage and remaining data update automatically. Cash sale, voucher redemption and network connection are distinct events with their own evidence.

This is the primary customer workflow while direct provider and bank integrations are being qualified. It works without online checkout or SMS. Source tests exercise it against isolated services; production still requires enrolled staff, published commercial terms and a qualified router/deployment.

## Set up the sales location

An administrator completes password and authenticator sign-in, approves the agent application, assigns the agent's site and allocates published bundle inventory. Pending, suspended or unassigned staff cannot issue sales for that site. The service resolves the current staff role and scope for each authorized action; the UI is not the authority.

The published bundle defines the integer minor-unit cash price, currency, byte allowance, validity and start-by policy. The server snapshots these terms and the commission when the sale commits. An agent cannot submit an arbitrary price, commission or allowance. Stock is debited in the same database transaction that creates the sale, voucher, private receipt association and outbox event.

## Customer and agent steps

1. **Choose the bundle.** The customer opens a published bundle or the “Pay an agent” area. When online checkout is disabled, the bundle still leads to the cash receipt workflow. Confirm that the agent has the correct site and stock before taking cash.
2. **Pair the customer's account.** The customer creates a short-lived private pairing code on their own device and shows it to the agent. The pairing belongs to the customer session. It is not an account password or a voucher.
3. **Confirm cash and issue.** The agent selects the site and bundle, enters the pairing code and chooses private receipt delivery. The agent checks the confirmation for the exact displayed amount, then submits “Confirm cash and issue voucher.”
4. **Read the receipt.** The customer's open receipt view checks automatically while the pairing is pending. The receipt shows the issued bundle, price, allowance, validity, start-by date, sale reference, private voucher and recorded cash confirmation. Check these before redeeming.
5. **Redeem once.** The customer explicitly redeems the receipt's voucher. The service binds the entitlement to that customer and handles duplicate redemption safely. The new allowance is queued; this does not prove a device is connected or start its validity timer.
6. **Connect when the site is qualified.** The customer requests the temporary hotspot credentials and signs in at the selected site. Validity starts with verified router accounting Start. Both uploaded and downloaded data count against the allowance.

SMS options remain unavailable when delivery is not configured. If SMS is later qualified, submitting a message remains distinct from verified handset delivery. Private paired receipt delivery does not depend on an SMS provider.

## What cash confirmation proves

New agent inventory sales require a cash attestation containing the exact server price and currency. The service records the authenticated agent, amount and confirmation time. The database enforces immutable tender evidence and prevents a later request from rewriting it. Receipt data labels this as `agent_attestation`.

This is evidence that the agent confirmed receiving cash. Software cannot independently observe physical banknotes. The administrator's operating process must still reconcile the agent's recorded sales, physical cash, commission and inventory. The application does not claim bank settlement or an automated physical cash refund.

Historical committed sales that predate tender evidence remain recoverable with an explicit **unrecorded** method. The application never invents a past cash confirmation to make a legacy receipt look complete.

## Lost responses and corrections

The agent browser saves a per-agent idempotency key and the exact request body before submission. If a response is lost or the page reloads, the UI restores that request and offers a safe retry. It instructs the agent not to collect cash again. The backend serializes the retry, returns the original committed receipt and does not debit stock or issue another voucher.

Legacy saved bodies are retried unchanged. New cash fields are not appended to a historical request: that would change the original request's meaning. A changed amount, currency, pairing or cash declaration under the same committed key is rejected as an idempotency conflict.

Specific domain rejections such as unavailable stock, an expired pairing or mismatched cash amount occur after replay lookup and roll back the new transaction. Only those known rollback outcomes allow the UI to discard the pending request and correct its details. A network timeout, gateway error or unavailable service remains ambiguous and preserves the pending request.

If cash was physically collected but issuance is rejected, the agent must agree the correction with the customer or return the cash. Do not mark a second sale paid or create arbitrary access to conceal the failed issuance. Expired pairings can be replaced by a fresh customer-generated code after the saved request's outcome is resolved.

## Automatic usage display

The visible customer usage view reads the authenticated `/v1/usage` snapshot every five seconds. It refreshes on focus/reconnection and after relevant mutations, pauses in inactive views and backs off after errors or rate limits. It retains the last confirmed balance with an explicit delayed/offline label; a failed request does not display a fabricated zero.

The service reads one consistent database snapshot with a two-second query limit. Totals cover every eligible entitlement, independent of history pagination. Byte totals remain exact decimal strings through the API and use integer arithmetic for the balance. Active and queued allowance are shown separately, alongside the current connection or account-review state.

The UI distinguishes **when it checked the ledger** from **when a router report was received**. Current RADIUS configuration requests accounting updates every 60 seconds. A five-second screen refresh cannot invent usage that has not arrived from the router. No animated countdown or optimistic byte deduction is used to imply otherwise.

Connection reservations are shown separately and are not deducted from the remaining balance a second time. A reservation may still require review after its bundle has expired or been reversed, so it can exceed the currently usable allowance. A held or uncertain connection does not instruct the customer to buy another bundle to clear the review.

History and usage responses are bound to the resolved customer. Owner/generation guards discard late responses after logout or an account switch. An older history response cannot overwrite newer usage counters, and stale connection responses cannot restore private credentials after freshness is lost.

## Test evidence and limits

The isolated acceptance journey uses actual administrator and agent registration, authenticators, approval, site allocation, a customer session, cash sale, private pairing and redemption. Unique synthetic staff addresses use a reserved `.test` domain. These are disposable application accounts, not real personal inboxes or merchant registrations; the current staff flow does not send a verification email.

The guarded accounting fixture then calls the real grant/accounting functions for that test's sole redeemed entitlement with cumulative 1,000,000 upload and 2,000,000 download bytes. The browser must observe the changed used/remaining balance automatically, without clicking refresh. Repeating the same cumulative report does not debit twice. Cleanup is restricted to that test's owned identities, site, sale and labeled network grant.

See [TESTING.md](TESTING.md) and [BUILD_STATUS.md](BUILD_STATUS.md) for completed exact-revision test records. Browser fixtures prove application behavior. They do not replace physical router enforcement, real staff enrollment, native cookie acceptance or off-host operational qualification.
