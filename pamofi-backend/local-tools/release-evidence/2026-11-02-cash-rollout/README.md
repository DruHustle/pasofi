# Cash rollout discovery — 2 November 2026

**Status: prepared and under verification; no production cash deployment or live cash acceptance has been completed.** Do not interpret this record as a go-live approval.

## Verified resources

- GitHub repository: `DruHustle/pamofi`; reviewed PR: <https://github.com/DruHustle/pamofi/pull/1>.
- Vercel account/project: `druhustles-projects/pamofi`, project ID `prj_B1WycqyAGBUjtwR3H7YScIuIpCJu`. The existing production alias is <https://pamofi.vercel.app>, deployment `dpl_5BEsB2VG4xopUMmS1WzhJhuc2sDp`. The production homepage returned 200; `/api/capabilities` and `/api/session` returned 404 during discovery. The project was subsequently configured with root `pamofi-frontend/web`, Node 24, `npm ci`, `npm run build` and `dist`; the non-secret production frontend/API origins and `NODEJS_HELPERS=0` were added. The production proxy credential remains unset, and the existing production alias was not changed. The prior project settings and deployment ID were recorded for rollback.
- A clean, separately protected monorepo preview, `dpl_H5e36gCpPVhvJxggiTrNcFhso8xe`, built successfully after the project configuration change. Its API function returned JSON `503 api_unconfigured`; this is not a connected production deployment and it has no production proxy credential.
- Oracle instance: `PamoFi Backend`, `ocid1.instance.oc1.eu-frankfurt-1.antheljtdhe5tbacpqjlmtw4kpzuy3k3imfh7dn62w55uhwnlnyy2aizu34a`, Frankfurt AD1, `VM.Standard.E2.1.Micro`, x86-64, 1 GiB RAM. The verified public IPv4 `130.61.203.168` is ephemeral. It shares `software-engineering-backend-public-subnet`; the shared security list permits public 443, not public 80. No cloud networking changes were made.
- The host runs `pamofi-staging` and its persistent volume `pamofi-staging_database`. Aggregate discovery showed no customers, sessions, orders, entitlements, or published bundles. It uses `/var/lib/postgresql/data` as `PGDATA`; the reviewed production stack expects `/var/lib/postgresql/data/pgdata`. The new read-only preflight was run against that actual staging volume and correctly rejected its root-level layout. Never repoint the production stack at it without a reviewed migration and recoverable backup.
- Proposed API hostname: `pamofi.onesa.eu`. At discovery it had no A or AAAA record; `onesa.eu` used Cloudflare nameservers. DNS, certificate issuance, renewal and the live API are not configured by this record.
- The owner supplied a private Backblaze bucket named `pamofi-B2-blazebucket`, region `eu-central-003`. Its native name contains uppercase characters; S3 compatibility has not been verified. Object Lock is enabled and the bucket currently retains all versions. Credentials, an off-host backup, retention, scheduling and restore remain unqualified.

## Release images

The locally built `linux/amd64` images below use service and web source from commit `8b62d684d11a1636452f1d7ac084d6c126506d63`; those source directories are unchanged through `a9b0a2c3c08c08b3ee24228c4f25ffc98b3e8e96`. They have not been deployed to Oracle. IDs are local Docker content IDs, not registry digests:

| Image | Local image ID |
| --- | --- |
| identity | `sha256:bd5592749b6f728ae9b3012f6f97b649e5e3f8d5b04523cbff84b2e7b1eb4ec5` |
| prepaid-access | `sha256:894519555f8944e3949d2f15383dcb25939e132f509cde6fde3c2c0811379d46` |
| network | `sha256:bf97c3c7cb35b4696ce66fff34f8fc1244f1e1ca6581b4dbd48d88dfddf57c2b` |
| notification | `sha256:3db3b1fe7d4935355fcae3288100f9f00945712bd3ad3e9ec35e8c0e3ab10f47` |
| assistant | `sha256:e3469c1222b0cc31453e80f0cd32c0447566846d5fd4dc6163f51eea68085268` |
| web | `sha256:baa7d2b8538a014482cd40c76ca2ef1191d73b83a4c390dd7fad02f198df1cf0` |

The six-image archive for `a9b0a2c3c08c08b3ee24228c4f25ffc98b3e8e96` has SHA-256 `84fde91336e9aa7e80d6ca7151aa30436f622003998caabcf8e8a82ef4e20498` and is retained outside the repository on the operator's Mac. A release must record the final source and actual deployed image digests again.

## Verification and remaining decisions

- The owner approved the existing five candidate bundle terms, 5% agent commission and Kuwadzana as the first site. Production catalogue publication, initial stock allocation, permanent administrator enrollment and agent approval have not occurred.
- Previous exact-source [CI run 41429316330](https://github.com/DruHustle/pamofi/actions/runs/41429316330) and [native run 41429316252](https://github.com/DruHustle/pamofi/actions/runs/41429316252) passed at `8b62d684d11a1636452f1d7ac084d6c126506d63`. A repeat [run 41434996304](https://github.com/DruHustle/pamofi/actions/runs/41434996304) failed during network migration in the RADIUS lab; it did not expose the migration error. A temporary PostgreSQL initializer readiness race was found and corrected at `8d0c61ca1dfdec688bb8c350129c1832bf48acb8`; the real-packet lab and a deterministic readiness regression passed locally. The original CI failure's exact cause remains unproven. The corrected [full CI run 41437583242](https://github.com/DruHustle/pamofi/actions/runs/41437583242) and [native run 41437582943](https://github.com/DruHustle/pamofi/actions/runs/41437582943) both passed at `8d0c61ca1dfdec688bb8c350129c1832bf48acb8`.
- The subsequent volume-safety change passed the [full verification run 41438943251](https://github.com/DruHustle/pamofi/actions/runs/41438943251) and [native run 41438943270](https://github.com/DruHustle/pamofi/actions/runs/41438943270) at `a9b0a2c3c08c08b3ee24228c4f25ffc98b3e8e96`. Any subsequent source revision must be requalified.
- An automatic approval review rejected exporting an encrypted staging database/configuration snapshot to the operator's Mac because it could contain sensitive records and secrets. No such snapshot was taken. A specifically authorized rollback point and independent production backup/restore are required before replacing the running staging deployment.
- No actual production cash sale, provider payment, SMS, router configuration or physical hotspot test has been performed. Production backup schedules, alert delivery, capacity under load, mobile-device sessions, and release signing remain unverified.
