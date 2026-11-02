# Mobile-first production release — 2 November 2026

The subsequent [availability release](../2026-11-02-availability-release/README.md) supersedes the website deployment and rollback references below.

This record distinguishes the live guest checks from isolated tests. It does not certify that PamoFi is ready to sell or deliver Wi-Fi.

## Production deployment

- Website: <https://pamofi.onesa.eu>, Vercel project `druhustles-projects/pamofi`, deployment `dpl_5giYTbZ3thfAd48mShD4L11F1aVR`, source merge `55b526956877bd648684f2ba0ec11157263e7912`, tree `138e4b4dabea54c5bcea0fe41b476ae8b25c0ff8`. The previous deployment `dpl_J4puUe7nXLnxswY651D3rj3wPE9q` is the frontend rollback reference. The deployment includes the Vercel API gateway function and `/connect` and `/handoff` rewrites.
- The merged source passed [full verification](https://github.com/DruHustle/pamofi/actions/runs/41486695005) and the [UI build](https://github.com/DruHustle/pamofi/actions/runs/41486694980). A clean archive of the exact source passed the build, 12 proxy tests, and 47 local browser journeys.
- The [native build run](https://github.com/DruHustle/pamofi/actions/runs/41486695013) passed Android. Its iOS job was cancelled while queued, including a retry, with no build steps executed. The [earlier native run](https://github.com/DruHustle/pamofi/actions/runs/41484319410) passed iOS and Android for the identical source tree. This is build evidence, not signed release or real-device acceptance.
- A pre-existing production help issue described demo accounts and two sites even though production was not a demo and had no sites. [PR #9](https://github.com/DruHustle/pamofi/pull/9), source `14efc86f788e5335a8c66591a9e03133c653e046`, corrected that copy and passed [full verification](https://github.com/DruHustle/pamofi/actions/runs/41505223104), including service and infrastructure checks. Four assistant tests also passed against a disposable isolated PostgreSQL instance.
- Only the assistant image changed on the shared Onesa host. Its immutable local image ID is `sha256:b576164f61cc1014389ff88c114934702d5fccad97611952c80b400c127d531d`; its base and rollback image ID is `sha256:1109da87a4d47fe54e1e2c27d793964356afc1d20234c73dfcd48a594ebb3cd7`. The previous assistant Compose configuration is retained at `/home/ubuntu/pamofi/production/rollback-help-14efc86`; use all required production Compose overlays and the explicit environment file as documented in the operations runbook. The release changed no database schema or commerce settings.

## Production guest checks

A clean Chrome incognito session was used without creating a customer account. The live home, bundle browsing, history, account, help search, captive welcome and handoff entry were inspected at widths 320, 390, 430 and 1280 CSS pixels. Voucher and handoff forms were not submitted. The only observed console messages were expected unauthenticated session 401s. The production views were visually inspected; production screenshots were not saved.

`/`, `/connect` and `/handoff` returned HTML 200; the public capabilities, bundles, sites and help APIs returned JSON 200 with `no-store`. Anonymous session, access and usage returned JSON 401, and an internal route returned JSON 404. Direct unauthenticated API access to Oracle returned 403. CSP, HSTS, `nosniff` and referrer headers were present. The corrected help response was verified after the backend change.

Production reported payment checkout, vouchers, receipt pairing, staff sales, SMS, network access and mobile cookies disabled, with an empty catalogue and no sites. These observations are not evidence of a purchase or working hotspot. All PamoFi service health checks passed, PamoFi health, certificate and backup timers were active, and other Onesa containers were healthy. An encrypted configuration recovery copy was refreshed and its decryption and archive listing checked, with the recovery key stored separately on the operator Mac.

## Synthetic screenshot evidence

The following images come from the isolated browser suite, with mocked API responses and a **synthetic account and synthetic data**. Their balance, offers and hotspot do not represent production:

- [320 px](synthetic/home-320.png)
- [390 px](synthetic/home-390.png)
- [430 px](synthetic/home-430.png)
- [1280 px](synthetic/home-1280.png)

The [complete CI screenshot artifact](https://github.com/DruHustle/pamofi/actions/runs/41486695005/artifacts/13163635048) is subject to GitHub artifact retention and is scheduled to expire on 5 November 2026.

## Outstanding acceptance

The owner deferred administrator MFA enrollment. Catalogue publication, agent enrollment and stock allocation, a reviewed live cash sale, receipt, voucher redemption and allowance acceptance remain outstanding. Payment and SMS providers are unqualified; the private RADIUS/router path and physical hotspot have not been accepted. Authenticated customer session-cookie lifecycle, native cookies, signed mobile releases and real-device operation require authorized testing. No production test customer, transaction or router configuration was created for this release.
