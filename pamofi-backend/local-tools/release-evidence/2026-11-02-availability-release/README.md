# Availability and navigation production release — 2 November 2026

## Deployment and rollback

The website at <https://pamofi.onesa.eu> serves Vercel project `druhustles-projects/pamofi`, deployment `dpl_4obF4knNS2ycWz8nftHUAULMTxPs` (`https://pamofi-cbtc6e988-druhustles-projects.vercel.app`), built from main merge `624ab511c1cdc8ee0750d9456d3faa5700042127`, tree `19532d33c4d478c345af4cc614a9f67b370537ae`. The deployment is ready and includes the API gateway. The previous production deployment `dpl_5giYTbZ3thfAd48mShD4L11F1aVR` is the rollback reference. Retain the existing Vercel project settings, environment and Oracle proxy boundary if rollback is required; do not change service capabilities as part of frontend rollback.

[PR #11](https://github.com/DruHustle/pamofi/pull/11) was merged. The exact merge passed [full verification](https://github.com/DruHustle/pamofi/actions/runs/41522610839), including customer sign-out, cross-tab sign-out, disabled catalogue, refresh and recovery tests, and the [UI build](https://github.com/DruHustle/pamofi/actions/runs/41522610797). The merge's [native workflow](https://github.com/DruHustle/pamofi/actions/runs/41522610731) passed Android but the iOS job was cancelled before running, so the workflow is marked failed; the [PR native workflow](https://github.com/DruHustle/pamofi/actions/runs/41520693550) passed iOS and Android for the identical tree. These are build results, not real-device acceptance.

## Production checks

In an isolated Firefox private guest session, the `/connect` welcome rendered and Explore bundles focused the catalogue. Bundles navigation opened `/#bundles` and showed the empty catalogue; Refresh availability could be pressed and returned focus to the catalogue heading. The footer recovery action showed **Recover your account**. Account tools displayed **Online payment**, and the section stated that checkout is not enabled. No account, payment, voucher or receipt was created. A live authenticated customer sign-out could not be verified because no authorized disposable production account was available; the isolated CI suite covered successful, failed and cross-tab sign-out.

The live `/` and `/connect` returned HTTP 200. Public capabilities, bundles, sites and help returned JSON 200 with `no-store`; anonymous session, access and usage returned JSON 401; the protected internal route returned 404; and direct unauthenticated Oracle API access returned 403. The public domain was confirmed to point to the recorded ready deployment.

## Operational state

The authoritative public capabilities reported demo disabled, online checkout, staff sales, vouchers, receipt pairing, SMS, mobile cookies and network access disabled. The catalogue and sites were empty. Browsing and recovery entry are available, but customers cannot yet buy online or from agents, pair a receipt, redeem a voucher, receive SMS or connect through the hotspot. Publishing the approved catalogue, setting up the site and agent stock, administrator MFA, provider qualification and physical router acceptance are separate operational steps. Authenticated customer sign-out, real payment and physical network access are not claimed as production-tested.
