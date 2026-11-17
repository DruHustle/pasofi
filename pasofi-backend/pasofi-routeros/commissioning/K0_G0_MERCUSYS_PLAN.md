# PasoFi gateway and AP redesign — K0/G0 (17 November 2026)

**Status: owner-supplied target topology, not installed-router evidence.** The machine-readable, fail-closed topology is [topology.target.json](topology.target.json), verified by [topology.test.mjs](topology.test.mjs). It neither changes RouterOS nor creates a NAS/entitlement.

## Names, gateways and boundaries

| Site | Internet / WAN | HotSpot/RADIUS gateway | Downstream customer/home equipment |
| --- | --- | --- | --- |
| Kuwadzana | Starlink → **K0**, MikroTik hEX | **K0** owns the captive portal, DHCP guest pool, RADIUS NAS identity and guest limits | K0 LAN1 → **K1**, MikroTik hAP lite in bridge/AP mode; LAN2→K2, LAN3→K3, LAN4→K4 are future, **not installed** |
| Goromonzi | Starlink → **G0**, MikroTik hAP lite | **G0** owns guest captive portal/RADIUS; home traffic must be separately protected | G0 LAN1 → **G1** home AP; G0 LAN2 → CPE1 5 GHz radio. CPE1→CPE2 existing radio link → Ethernet→ **G3 Mercusys router** in AP mode. CPE1→a *new compatible 5 GHz client CPE* (not installed)→Ethernet→ **G2 Mercusys router** in AP mode. G0 LAN3 reserved |

The physical MikroTik ethernet interfaces are proposed, **not observed**. Inspect all device serials, actual hEX model, its RouterOS version and WAN/LAN port numbering before matching the labelled ports to `ether1`–`ether5`.

**Old G1 was the MikroTik gateway; its intended new label is G0.** Site-facing labels are display names only. Never automatically rename/rotate the existing NAS UUID, source `/32`, WireGuard key, RADIUS secret, identity, receipt site ID or accounting session identifier. Migrate these only through a traced, reversible operator-controlled change.

## CPE1 must keep CPE2 linked while G2 joins

G2 and G3 are **Mercusys routers**, with exact models and revisions not yet supplied. Do not assume either has 5 GHz client/station/WDS support. Both should serve as Ethernet-fed downstream access points, with no NAT, DHCP server, independent HotSpot or RADIUS NAS.

- **CPE1–CPE2 is the current uplink to G3.** Inspect each Tenda CPE model, hardware revision, firmware, RF channel width, encryption and configuration before changing mode.
- **G2 requires an independent compatible 5 GHz wireless receiving CPE** unless its *specific* inspected Mercusys model and firmware can demonstrably bridge the same 5 GHz CPE1 wireless link transparently **without disturbing CPE2**. The plan currently assumes a separate G2 receiver, marked absent; do not claim service at G2.
- Confirm CPE1 can run an **AP with at least two clients / point-to-multipoint** under the selected firmware, with acceptable signal, alignment, airtime, legal EIRP and throughput. Some point-to-point bridge modes do not accept a second client. Reconfiguration can break the active link: retain an independent management and rollback path.
- **G2 and G3 must forward each client's real MAC/IP to G0.** Disable downstream NAT/DHCP and avoid wireless client isolation that prevents required HotSpot traffic; enable AP guest/client isolation separately and test it. Follow model-specific Mercusys native AP wiring (which may use the WAN port) or DHCP-off LAN-to-LAN fallback, **not both**; see [Mercusys AP guidance](../MERCUSYS_MR20.md) only if hardware matches MR20.
- Separate G1 home users from the business guest bridge. Never put G1 home and CPE1 business backhaul in one unfiltered L2 customer network; ensure home traffic doesn't see/pay for HotSpot or bypass its guest firewall.
- Preserve trusted HTTPS HotSpot PAP, RADIUS `Message-Authenticator`, private tunnel, one entitlement per customer policy, IPv4 and IPv6 guest isolation, byte accounting (up/down), interim, Stop, disconnection, replay and cross-site quota sync.

## Safe commissioning sequence

1. **Read-only device inventory:** Record actual K0, K1, G0, G1, both CPEs, G2 and G3 hardware ID, model/revision, RouterOS/firmware, existing configuration, management IP, physical port, DHCP/NAT/bridge and live link state. Do not mix old **site-01 hAP lite** scripts with the new **K0 hEX** gateway.
2. **Back up and preserve:** Export a private encrypted device backup, confirm independent owner-only access and a rollback procedure; capture CPE1→CPE2/G3 link uptime/quality before touching CPE1.
3. **Validate network intent:** `node pasofi-backend/pasofi-routeros/commissioning/topology.mjs` returns `design-unverified`. A passing JSON validation is not a physical test. Prepare private per-device baselines and WAN/LAN split/guest firewall policy using the existing baseline and commissioning tools.
4. **Stage K0 and G0 independently:** Commission gateway NAS identity, certificate, RADIUS private source, guest DHCP/HotSpot bridge and management access only on the exact serial-pinned router. Start disabled; preserve upstream/home path, avoid duplicate DHCP and conflicting subnets. On G0 especially, inspect hAP lite 32 MiB RAM/CPU capacity and HotSpot package/device mode.
5. **AP bridge and radio tests:** First validate K1 AP, then G3 through CPE2 with the current link intact. For G2, install and qualify the receiving CPE independently without disconnecting CPE2; observe both radios live simultaneously before using a shared guest service. Future K2/K3/K4 remain absent and disabled.
6. **Commercial cash acceptance:** An approved staff member receives exact cash and attests payment in an active site shift with allocated stock. The backend issues a one-use private voucher/receipt, a customer redeems it, and a test phone with cellular data off reaches internet via trusted HTTPS HotSpot and RADIUS Start/Interim/Stop. Verify exact byte exhaustion, disconnect, no alternate unmetered route, refund handling and cross-site reconnect. Record *actual* test values privately.
7. Declare separate **site GO/NO-GO**; never release a site merely because CI passes or a Vercel page renders.

## SMS mobile money and native wallet gate

The existing **cash** flow is independently implementable with agent-assisted receipt/voucher. SMS-based EcoCash merchant notifications are *only payment leads*, not authoritative proof of settlement. An authorized operator must independently verify the merchant account's actual incoming transfer, exact merchant/currency/amount/reference, uniqueness and reversal state before a non-cash voucher is issued, with a distinct audit/payment method. **Do not label a mobile-money transfer as cash to bypass acceptance.** No SMS parser or automatic voucher release from a customer screenshot/SMS is authorized. See [manual EcoCash SMS qualification](../../docs/ECOCASH_SMS_MANUAL_PILOT.md).

Native iOS/Android clients already contain Stripe PaymentSheet code paths and Apple Pay/Google Pay options, but preview APK/simulator builds and test accounts do not qualify a live charge. These remain disabled until the actual merchant account, native wallet registrations, signing/entitlements, backend webhook and refund process are qualified. Agent cash voucher redemption may be tested separately in signed apps when their production customer/API origin and user login are ready.
