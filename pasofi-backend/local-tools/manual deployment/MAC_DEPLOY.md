# PasoFi automatic Mac deployment

**When you are ready to deploy, extract the ZIP and double-click `Start_PasoFi.command`.**

The launcher finds the existing server, checks its recorded installation, qualifies a fresh backup through an isolated restore, deploys the pinned application source, and runs the server and public website checks. It has no configuration form or `APPLY` prompt. Running this entry point requests the application deployment.

To start from Terminal instead, open the extracted folder in Terminal and run:

```sh
/bin/bash ./Start_PasoFi.command
```

Keep the folder's files together. Leave `source.tar.gz` compressed. Folder names containing spaces work. `release-deploy.command` with no arguments performs the same automatic workflow.

## Details already filled in

| Setting | Value |
| --- | --- |
| Preferred existing SSH alias | `onesa-portal-worker` — provided address `100.80.225.21` |
| Existing fallback SSH alias | `onesa-portal-worker-public` — provided address `92.5.170.138` |
| Public website | `https://pasofi.onesa.eu` |
| Backend HTTPS boundary | `https://api.pamofi.onesa.eu` |
| Source release and archive checksum | Included in `release.json` |
| Existing project, ordered Compose overlays and environment files | Read automatically from the running installation's recorded metadata |
| Expected PostgreSQL cluster | Independently retained server record, checked against the running database |

The launcher uses the aliases already configured on your Mac. It does not infer an SSH username or copy a private key into the package. The preferred alias is tried first; the public alias is a connection fallback. Missing or inconsistent installation records stop the operation before application changes.

## What the Mac needs

Python **3.9 or newer**, OpenSSH (`ssh` and `scp`), an available SSH key or agent, and a previously trusted host record for the existing server are required. The helper finds common Python installations on Intel and Apple Silicon Macs. Git, Node and Docker are not required on the Mac.

The existing Linux server needs Python 3.9+, Docker Compose, access to the protected installation files, its recorded database identifier, and its working encrypted pgBackRest repository. These are existing installation prerequisites. The launcher does not install a new database, fabricate missing records, accept an unknown host key, request a password or alter SSH configuration.

If the SSH key is encrypted, unlock it through your normal Mac SSH agent before starting. If the connection is not already trusted, verify its fingerprint through your existing server record. The launcher will identify an unavailable connection without trying alternative credentials.

## Automatic steps

1. **Check the package and server.** Verify the source checksum and Git commit, discover the single recorded PasoFi project and complete overlay/environment order, and compare the retained database identifier with the running cluster.
2. **Check the proposed deployment.** Verify that the rendered configuration agrees with the existing mounts, networks, ports, environment and protected containers.
3. **Prove the fresh backup can be restored.** Validate the known encrypted repository and reject pgBackRest environment/include overrides. Create a fresh backup without expiring older sets. Restore that exact captured label, using the running database's immutable image, into a new temporary volume. Verify the retained cluster identity and all five captured migration ledgers. Remove only resources carrying this operation's unique ownership label and expected names. Failure or unconfirmed cleanup stops deployment.
4. **Build and deploy.** Build from the pinned archive and run the applications' owned pending migrations. Update network first, then prepaid access, then the remaining applications, web and gateways. Each dependency must run its exact built image and pass health and local readiness checks before the next phase starts. Preserve the existing ordered overlays, provider/feature gates, protected PostgreSQL and RADIUS containers, and optional fleet overlay. A mounted captive portal is rebuilt in its dedicated mode.
5. **Run post-deployment checks.** Check immutable image revisions, all five target migration ledgers, HTTP health, the retained database, unchanged feature gates, aggregate queue counts, and scheduled-operation status. Check public HTTPS, capabilities, anonymous customer/staff denials and blocked internal/direct API paths. Unexpected cookies, redirects or denial envelopes fail the relevant check.

The restore is isolated **on the existing server**. It does not prove recovery onto a replacement host. Timer observations report status only; they do not prove delivery of operational alerts.

The package updates the server's Compose web/captive target. Vercel and mobile releases are separate. Activate the updated hotspot clients only after verifying the network and prepaid backend release and its explicit access-point/site/NAS response contract. A failed runtime phase leaves the remaining phases stopped and the existing uncertain-operation handling in place.

## Results and safe retries

The launcher saves `result.html` and `result.json` under a new private `PasoFi_Results/run-…` directory beside the package and opens the HTML result on the Mac. The result distinguishes deployment success from checks needing attention and always leaves physical customer acceptance outstanding.

Private control records live in `~/Library/Application Support/PasoFi/Deployments`, keyed by the retained database, project and release. They survive copying or extracting the same package again:

- A confirmed completed deployment runs **read-only checks** on the next launch.
- An interrupted or uncertain deployment runs checks and blocks a second automatic application. A failed SSH response can arrive after some server work completed; the launcher does not guess.
- The original feature-gate baseline is retained for comparison during a retry.

Do not delete these control records to force another deployment. Review the private server release record first. The server also keeps a project lock, original image IDs/configuration references and an application rollback command. Rollback restores application images and binds; it does not put an old database over later sales or payments.

For observations without requesting a rollout, run:

```sh
/bin/bash ./hotspot-readiness.command
```

For automatic configuration preflight plus public checks without a new rollout, run:

```sh
python3 -I -B -S ./pasofi-auto.py --no-open
```

A preflight-only run does not fail merely because the current application is older than the packaged release. An existing pending/completed operation record still triggers the appropriate read-only target-release checks.

## What still needs physical acceptance

The package does not configure the routers from the Mac, enroll unverified fleet endpoints, issue a real sale, send customer messages or activate digital payment providers. Those require their actual devices and operational acceptance. Follow `CASH_HOTSPOT_LAUNCH.md`, `TWO_SITE_HOTSPOT_ACCEPTANCE.md` and `ROUTER_FLEET.md` supplied in the package.

Before serving customers, prove the real captive sign-in, controlled cash sale/receipt/redemption, paid network admission, accounting, disconnect, quota/expiry and reconnect behavior on the routers and phones. Keep checkout disabled until its actual provider integration is qualified.

## Package qualification

`RELEASE_EVIDENCE.json` records this package's exact source, local checks and any recorded CI results. A prepared package is not evidence of an Oracle deployment, a Finder launch on your particular Mac, an off-host recovery or a successful customer session. Server deployment remains deferred until you run the launcher.
