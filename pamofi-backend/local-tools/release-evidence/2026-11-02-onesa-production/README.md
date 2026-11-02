# Onesa production deployment — 2 November 2026

The later [mobile-first release record](../2026-11-02-mobile-first-release/README.md) supersedes the website deployment and assistant image identities below; the remaining details here describe the earlier deployment.

This is a deployment and recovery record, not cash-sale or hotspot acceptance. The owner deferred administrator MFA enrollment. Production cash commerce, online payments, SMS and customer network access remain disabled; no live cash transaction or physical hotspot test has been performed.

## Verified deployment

- Website: <https://pamofi.onesa.eu>, Vercel project `druhustles-projects/pamofi` (`prj_B1WycqyAGBUjtwR3H7YScIuIpCJu`), production deployment `dpl_J4puUe7nXLnxswY651D3rj3wPE9q` from source head `bd02a7cc6d1e5ef5c57ce80f69135d6fd12b8fb5` (merged as `ff16b6f04828481e24236a073e81c472fbc8c336`). The full [verification run](https://github.com/DruHustle/pamofi/actions/runs/41471839635) and GitHub Android build passed for that head. The unsigned iOS simulator build passed locally; the equivalent GitHub iOS job was still queued when the release was recorded. Previous deployment `dpl_2gj3Cgd3CMf9bCxheh2qGRUUcmBX` is a rollback reference. Later website releases must record their own deployment and source revision.
- API: <https://api.pamofi.onesa.eu> on the owner's `Onesa UG Backend`, instance `ocid1.instance.oc1.eu-frankfurt-1.antheljsdhe5tbaceekd4uxnzp5trhvl5miigwg3gk2kyyayue7jp54co6jq`, Frankfurt, ARM64, 1 OCPU and 6 GiB memory. This host is shared with other Onesa services. Its public IP is ephemeral; verify DNS after any IP change.
- The Vercel API proxy uses a server-only credential and the Oracle public gateway has a separately trusted HTTPS certificate. The unauthenticated API gateway rejects direct capabilities requests; public internal paths return 404; an unauthenticated website session returns 401. `/api/capabilities` reports cash, digital checkout, SMS, network access and mobile cookies disabled. The production catalogue is empty.
- The first administrator was bootstrapped using an owner-chosen password; authenticator enrollment is pending. The owner approved the five candidate bundle terms, 5% agent commission and Kuwadzana as the first site. Catalogue publication, agent approval and stock allocation are pending; they are not inferred from those approvals.

## Running image identities

The application images were built for ARM64 from backend source `f202fabde8275ad7887c1f30d1426f8d5b1b4733`. Tags are retained on the host; the following are immutable local Docker image IDs, not registry digests. The website is separately deployed by Vercel.

| Container | Image ID |
| --- | --- |
| identity | `sha256:77f68c59b74785580270067a02feeb0d24220769707600ebe2cf375b2e64b5dc` |
| prepaid-access | `sha256:7b89b7c9282dfb3b7846d0fa3a62a319c286c46b123dd64f4a0c2f3b4892ebd5` |
| network | `sha256:8be2b1e92da61d4dc1063f911d3c02b1c4db85f176d1047cdcbea282502981aa` |
| notification | `sha256:8a0b2222dfc135042c8a676a43850d49174c0de668124517184df697f9270f05` |
| assistant | `sha256:1109da87a4d47fe54e1e2c27d793964356afc1d20234c73dfcd48a594ebb3cd7` |
| internal web | `sha256:971bd0dbc2f1e7ea32a2c0d20253411dacd7e16348e978a9df3f9038ac56a040` |
| PostgreSQL and pgBackRest | `sha256:dcea17f9173218490433f79700e84af92a1e2620acfac54d27a32a2936c109a5` |
| public gateway | `sha256:0e52bd054126cdc040b1276c0af347aeb02a41b9cfe305d6094767ac30e97949` |

## Recovery and monitoring

Encrypted PostgreSQL backups and continuous WAL use the independent Backblaze bucket `pamofi-B2-blazebucket` in `eu-central-003`. Full, differential and repository-check timers are active; a monthly restore drill uses an isolated temporary volume. An independent restore on the owner's Mac verified the database cluster identity and all five migration ledgers. Encrypted production configuration and keys are retained separately on the owner's Mac, with the decryption key in a separate recovery-key directory. Protect both copies and refresh the configuration recovery copy after key or configuration changes. The backup credential can delete objects in its scoped prefix; version retention is not immutable protection, and retained versions can accumulate storage costs.

The API-only Let's Encrypt certificate is renewed on a daily timer; a staging renewal dry run passed after the hostname switch. Vercel manages the website certificate. Host port 80 is opened only temporarily for API validation; the PamoFi gateway has a narrow port-443 host firewall rule. PamoFi service health checks, failure alerts and an Oracle host-metric absence alarm are active; the owner confirmed delivery of a test alert to the configured operations mailbox.

The previous PamoFi staging VM and protected rollback copies remain intact. The production rollback procedure requires the explicit Compose environment file and all production, Vercel, backup, network and public overlays, the recorded external database volume and compatible images. Review migration compatibility and fence the old authority before any database restore; never run disposable lab scripts against the production volume. See [Onesa operations](../../manual%20deployment/onesa/README.md) and the [production rollback runbook](../../../infra/operations/README.md).

## Still required

Administrator MFA, approved agent enrollment and a reviewed cash sale, receipt, redemption and allowance acceptance remain incomplete. Merchant/payment and SMS providers have not been qualified. The private RADIUS/router path and physical hotspot remain disabled and untested. Native cookies, real-device operation and release signing remain unqualified; the mobile client is an offline preview until that boundary is verified. No production readiness claim follows from the CI, deployment or backup evidence alone.
