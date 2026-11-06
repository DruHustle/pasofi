# Cash HotSpot acceptance record

**Status: pending live evidence.** Keep this record with the selected
`private-baseline.json`, `commissioning-plan.json` and `review.json`. Input validation, generator tests
and a completed row without evidence do not qualify the service. Retain the
full sequence and its timestamps; do not record passwords, customer recovery
credentials, complete vouchers, RADIUS secrets or private keys.

## Identification and topology

| Record | Actual value or evidence reference |
| --- | --- |
| Date, operator and release SHA | Pending |
| Hardware serial | Use private baseline; re-read from hardware |
| Model, RouterOS, packages, memory and uptime | Pending current read; compare with private baseline |
| Intended sales-site UUID and distinct NAS UUID | Use reviewed plan; verify corresponding real database records |
| Guest bridge, ports/SSID or VLAN and gateway | Use reviewed plan; verify actual membership |
| AP/CPE hardware, mode and physical port mapping | Pending; do not identify another device by a shared management address |
| Guest gateway owner across the CPE link | Pending; no double HotSpot or hidden downstream NAT |
| Recovery path and private rollback record | Pending; preserve baseline management, WAN and independent access |
| HotSpot HTTPS origin and certificate | Use reviewed plan; record actual validity and chain/hostname evidence |
| Service tunnel source and destination | Use reviewed plan; record observed source-preserved RADIUS packets |
| Private REST endpoint and public trust | Use reviewed plan; record TLS and actual hardware identity evidence |

## Ordered gates

Use **pending**, **pass** or **fail** with an evidence reference. A required
failure prevents public launch. Do not treat a browser success banner or an
application receipt as evidence for another gate.

| Gate | Required observation | Result / evidence |
| --- | --- | --- |
| Physical permission | After any required physical confirmation: inspected mode retained, `flagged=no`, `hotspot=yes`; same serial and packages | Pending |
| Recovery | Baseline management, WAN default route, DNS/Internet and CPE paths work after reboot; obtain a real customer DHCP lease later | Pending |
| Customer separation | Intended guest members only; management/CPE/recovery path retained; two phones have distinct IP/MAC host identities | Pending |
| IPv4/IPv6 and AP policy | Unauthenticated Internet blocked except exact approved destinations; guest-to-management and guest-to-guest isolation; no IPv6 or secondary NAT bypass | Pending |
| Private service | Fresh WireGuard handshake, exact `/32` source preservation, RADIUS request/reply traffic; no customer/private-service forwarding | Pending |
| Server enrollment | Correct existing runtime/database and site mapping; one intended enabled NAS for site selection during controlled testing; independent per-NAS secret; existing authority preserved | Pending |
| Trusted customer HTTPS | Exact registered `/login`, correct certificate chain/hostname/time/private key, real iOS and Android captive flow; credentials submitted only to that origin | Pending |
| Free welcome and expiry | If enabled: actual router-enforced time/rate/reset policy; no repeated free grant bypass; customer application still reachable after expiry | Pending |
| Authentication failures | Wrong, expired, revoked and wrong-NAS credentials rejected; unsupported CHAP/EAP/MSCHAP and plaintext login do not admit a customer | Pending |
| Cash sale and redemption | Controlled real cash sale through approved MFA agent, exact site/bundle/currency/stock/open shift, idempotent receipt and explicit customer redemption | Pending |
| Paid admission and Start | Mobile data off; intended NAS/exact HTTPS login; actual Internet traffic; authenticated accounting Start activates the intended allowance only once | Pending |
| Interim and quota | One-minute interim accounting with measured upload-only and download-only traffic, correct directions and cumulative totals; small quota actually cuts access | Pending |
| Disconnect and closure | Revoke/fence credential, query matching active ID, remove it, independently requery absent; final Stop and ledger closure, then same-site reconnect with remaining allowance | Pending |
| Cross-site account rule | After independent closure, same account at another qualified site retains allowance; simultaneous sessions are rejected; no extra grants | Pending |
| Outage and capacity | Independently interrupt uplink, private tunnel and router power; conservative uncertain holds and safe reconnect; actual intended client load without OOM/reboot | Pending |
| Public launch | Owner records acceptance for this site and enables only its required gates; unresolved sites remain pending | Pending |

## Controlled cash transaction

1. Verify the approved agent's MFA session and assigned actual sales location.
   Check the immutable bundle version, currency, available stock and open cash
   shift. Keep electronic payments disabled.
2. The customer requests a private cash reference. The agent verifies the
   displayed amount and receives the actual cash before confirming the sale.
3. Verify exactly one sale, stock decrement, voucher allocation and invoice.
   Retry the same request to confirm idempotency. Privately inspect the receipt
   and PDF; public customer lookup must not expose another customer's receipt.
4. The customer explicitly redeems the receipt. Verify an owned queued allowance
   with the intended volume, validity and start-by conditions. A sale itself
   must not silently create an active network session.
5. With mobile data off, obtain the temporary credential for the intended site
   and exact registered HotSpot URL. Record redacted Access-Request attributes,
   Access-Accept/session limits, real traffic, Start and subsequent Interims.
   Keep the issued password out of this record.
6. Verify validity begins through the authenticated Start/ledger transition
   under the existing conservative timestamp contract. UI refreshes are not
   additional accounting samples.

## Accounting and disconnect evidence

Record session ID, NAS/site IDs, redacted customer reference, timestamps,
upload/download deltas, accounting counters and ledger states. Compare upload
and download separately; check the 64-bit counter path using a qualified test
that does not assume a small-volume sample exercised wrap handling.

For each closure, prove **Stop → independently absent → closed → reconnect**.
Stop alone does not free the reservation. The reconciler must use the correct
restricted private REST account, remove only matching returned session IDs and
perform a new query that observes absence. Record any uncertain accounting hold
and the actual recovery action; do not force-release it to make a test pass.

Test exhausted volume, elapsed validity, unstarted allowance past start-by,
deliberate disconnect, delayed/replayed accounting and reauthentication. Show
that a failed/wrong NAS login cannot spend, duplicate or unlock the allowance.

## Policy and fault evidence

Inspect ordered rules and test actual traffic, including FastTrack interaction,
guest access to the MikroTik/CPE/MR20 management interfaces, wireless peer
isolation that may never reach the gateway, private service address/other-site
denial, and unauthenticated destinations. Test the intended IPv6 policy on a
real client; RouterOS HotSpot enforcement depends on IPv4.

For free welcome, measure actual time/rate and repeat-use behavior separately
from paid entitlement. A MAC-based trial is not a per-person quota. Verify the
dedicated customer app after trial expiry and after paid quota expiry; do not
open a broad shared CDN or unrestricted Internet to make the portal load.

Interrupt each dependency separately, restore it and reconcile. Record router
free memory, uptime and error/reboot observations at the planned simultaneous
customer load. Do not infer a customer capacity from RAM size or a successful
single-phone test.

## Enablement and pause order

The authoritative order and individual feature gates are documented in
`pasofi-backend/docs/CASH_HOTSPOT_LAUNCH.md`. Router configuration, NAS enablement,
RADIUS authority qualification, private disconnect control, customer credential
issuance, commerce and site sales are separate controls. Central fleet
administration does not activate the reconciler or any sales gate.

If the controlled test fails after a session starts, pause new sales/credential
issuance first. Keep the necessary NAS/accounting/reconciler path available
until existing sessions are fenced and settled. Disabling the NAS first can
prevent the final authenticated accounting needed for closure.

| Release decision | Entry |
| --- | --- |
| Accepted site and tested customer path | Pending |
| Evidence record and exceptions | Pending |
| Measured client capacity | Pending |
| Owner decision and timestamp | Pending |
| Recovery/pause action tested | Pending |

Completion of this record qualifies only the observed site and paths. It does
not establish that another uninspected router, second site or unrelated deployment is
ready.
