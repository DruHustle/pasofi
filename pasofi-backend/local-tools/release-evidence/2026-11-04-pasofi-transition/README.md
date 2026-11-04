# PasoFi name and address transition — 4 November 2026

The existing Vercel project is now named `pasofi`. Production source revision
`3ffba8660fdb7d7b8b8d8d6c064d1fc0e77a1aef` is deployed as
`dpl_7wUxxTg5oy5V1hFgKyWBR4q8jGJy`. The primary site is
https://pasofi.onesa.eu and the Oracle API is https://api.pasofi.onesa.eu.
The earlier `pamofi.onesa.eu` and `api.pamofi.onesa.eu` addresses remain
accepted during the transition. Sessions are scoped to their host, so users
may need to sign in again at the new address.

The previous PasoFi deployment is `dpl_AyYbsegAehrLS1s61TkKBK54E4Y6`;
the pre-rebrand web deployment is `dpl_9kPvPAVvtLt9UfgKCA1XwizvdNcj`.
Backend rollback environment snapshots are stored on the shared Onesa UG
Backend under `/home/ubuntu/pamofi/releases/981ddd6-arm64/`. Rollback
must preserve the RADIUS containers and persistent volumes. The deployed
backend source tree corresponds to verified revision `981ddd6`; the merged
revision above has the same tree.

Both API hostnames are covered by the deployed transition certificate. An
encrypted recovery copy of the transition certificates was verified in the
existing independent backup bucket. Certificate renewal through the staging
CA could not be rehearsed because that CA endpoint timed out or reset the
connection from Oracle; real issuance succeeded. The new hotspot certificate
has not been installed on a router and router renewal/distribution still needs
an operational procedure.

The pilot radio is named `PasoFi Pilot` and is disabled. A DHCP-only test
assigned a spare device `10.77.10.10`; captive sign-in, RADIUS authorization,
metering, cash sales, and the actual Kuwadzana uplink remain to be qualified.
Lawfield Farm has not been commissioned. The router portal page in this
repository is not installed or physically qualified. Do not announce service
or enable sales solely on the basis of this release.

Some internal identifiers retain `pamofi`, including deployed container and
environment names, the backup bucket/prefix, and Oracle IAM or notification
names that cannot be renamed in place. They preserve existing data, access and
rollback paths; replacing them requires coordinated migration and validation.
