# Vercel frontend and Oracle backend

Use the explicit `vercel.compose.yaml` overlay when Vercel hosts the browser app and Oracle hosts the production services. The base `compose.yaml` continues to support the existing single-origin deployment. Applying the overlay is an operator deployment step; adding these files does not deploy, register a hostname, obtain certificates or qualify live provider/router access.

## Request and trust boundary

The browser uses the frontend's own `/api/*` URLs. Vercel's Node function forwards only the reviewed public API routes and methods to one configured Oracle HTTPS origin. Oracle authenticates that proxy before forwarding an API request to the private `web` service, whose independent API allowlist remains in force. The five service listeners, private gateway and PostgreSQL have no public host ports.

| Setting | Vercel | Oracle |
| --- | --- | --- |
| Browser origin | `PAMOFI_PUBLIC_ORIGIN` | `PAMOFI_PUBLIC_ORIGIN`; overlay sets every runtime service's `PUBLIC_ORIGIN` from it |
| Oracle TLS origin | `PAMOFI_ORACLE_API_ORIGIN=https://<Oracle API hostname>` | `PAMOFI_PUBLIC_HOST=<Oracle API hostname>` and matching public certificate/key |
| Proxy credential | Protected, server-only `PAMOFI_VERCEL_PROXY_TOKEN` | Individually mounted `vercel_proxy_token` secret file |
| Platform/body handling | Vercel sets `VERCEL=1`; committed configuration sets `NODEJS_HELPERS=0` | Root gateway startup reads the file and creates a private nginx configuration |
| Client identity | Canonical single address from Vercel's `x-vercel-forwarded-for` | Authenticated `X-PamoFi-Client-IP` becomes the forwarded client address |

Both configured origins must be exact, lowercase HTTPS DNS origins with no port, path, trailing slash, query or credentials, and they must differ. A single-label hostname, IP literal, one-letter final DNS label, `.local` or `.localhost` fails qualification. The local lab uses distinct `pamofi.test` and `api.pamofi.test` names with a disposable trusted CA; these are fixtures, not deployment values.

The 32-byte random proxy credential is encoded as exactly 64 lowercase hexadecimal characters. Vercel sends it as `X-PamoFi-Proxy-Token`. Oracle checks it case-sensitively and returns `403` for an absent, invalid or duplicated value. Client identity must parse as one canonical IPv4 or IPv6 address; malformed, noncanonical, list, port and zone forms are rejected. Vercel normalizes IPv4-mapped IPv6 into ordinary IPv4 to avoid differing textual representations.

The Oracle gateway never trusts a public caller's ordinary `X-Forwarded-For`, `X-Real-IP` or `Forwarded` headers. After authenticating the proxy, it replaces the downstream forwarding headers and strips both PamoFi trust headers and `X-Vercel-Forwarded-For`. The services continue trusting only the explicit private service-network CIDR. Do not expose `web` or an application listener through another public route.

Only `/health/live` is anonymously available on the Oracle HTTPS host. `/api/*` requires the proxy credential, and other paths return JSON `404`. The frontend origin serves the actual browser app and `/handoff`. Secure, HttpOnly, SameSite=Lax `__Host-` cookies therefore belong to that frontend host. The proxy preserves multiple setting/clearing cookies and disables browser/CDN storage of API responses. Backend origin/CSRF checks remain enabled against the exact frontend origin; no broad CORS allowlist or insecure cookie mode is introduced.

## Prepare Oracle's existing production installation

First complete the base [production prerequisites](README.md): immutable service and web images, the retained external database volume, non-overlapping private service CIDR, all application secrets, private service TLS, reviewed commerce settings, migrations and first-administrator procedure. Keep the same named database volume and existing secret set for subsequent releases.

For a new installation only, the existing `generate-secrets.mjs --new-install-only` creates the unchanged 29-file application secret set. Add the proxy credential to that protected directory separately:

```bash
node pamofi-backend/infra/production/generate-vercel-secret.mjs \
  --directory /absolute/protected/pamofi-secrets --add-vercel-proxy
```

This command requires an existing operator-owned `0700` directory outside the checkout, creates only `vercel_proxy_token` with mode `0400`, prints no value, and refuses every overwrite. The proxy token differs from the non-root application secrets: only the root gateway startup reads it. Keep it private when transferring the value to Vercel; never use a `VITE_` variable, committed environment file, frontend setting, URL, command-line argument or diagnostic log.

Supply `public_tls_cert` and `public_tls_key` for the exact Oracle API hostname. Set these non-secret values in the operator's environment, substituting the actual qualified names:

```bash
export PAMOFI_PUBLIC_HOST=api.your-domain.example
export PAMOFI_PUBLIC_ORIGIN=https://your-frontend.example
export PAMOFI_SECRETS_DIR=/absolute/protected/pamofi-secrets
node pamofi-backend/infra/production/preflight-vercel.mjs
```

The preflight checks separate canonical origins, private directory/credential ownership and file properties, credential format, exact certificate hostname, validity period and matching private key. It rejects symlink/hard-link secret files and writable group/other permissions. Its success status is deliberately `prepared-only`: it cannot establish public DNS routing, a publicly trusted certificate chain, Vercel environment values or live edge-header behavior.

Apply the overlay on **every** production Compose invocation for this deployment. For example, after setting all required base inputs:

```bash
cd pamofi-backend/infra/production
docker compose -f compose.yaml -f vercel.compose.yaml config --quiet
docker compose -f compose.yaml -f vercel.compose.yaml up -d --wait postgres
for service in identity prepaid-access network notification assistant; do
  docker compose -f compose.yaml -f vercel.compose.yaml \
    --profile migrate run --rm "$service-migrate"
done
docker compose -f compose.yaml -f vercel.compose.yaml \
  up -d --wait --wait-timeout 120
```

For the one-time administrator operation, include `-f bootstrap-staff.compose.yaml` together with those two files and follow the base bootstrap instructions. Backup, private site-link and RADIUS overlays remain separate, explicit choices with their own credentials and qualification.

The gateway runs with a read-only root filesystem and disposable `/tmp`. Its startup creates `/tmp/pamofi-gateway` as root-owned `0700` and both rendered configuration files as root-owned `0600`. The token appears in that private configuration so nginx can compare it; do not run `nginx -T`, print/copy the rendered file, or collect it in support archives. Startup validates nginx silently and emits only a generic failure if qualification fails. Restrict host/container administration to trusted operators.

Certificate renewal must refresh the individual file mounts and verify the served chain. Token rotation also requires coordinated replacement of the protected Oracle file and Vercel server environment; the additive generator intentionally does not rotate a live credential. Recreate the gateway after an approved file change, redeploy the matching Vercel environment, and repeat ingress/session checks. A mismatched token fails closed while the two deployments differ.

## Configure the Vercel project

The project root is `pamofi-frontend/web`. Its committed `vercel.json` selects Vite, `npm ci`, `npm run build` and output directory `dist`, and routes public API requests through `api/gateway.mjs`. See [the frontend deployment guide](../../../pamofi-frontend/web/README.md) for the handler and environment contract.

In the intended Vercel production environment, configure `PAMOFI_PUBLIC_ORIGIN`, `PAMOFI_ORACLE_API_ORIGIN` and the protected server-only `PAMOFI_VERCEL_PROXY_TOKEN`. Their values must exactly match the Oracle configuration and token file, without the file's final newline. Keep `NODEJS_HELPERS=0` so the handler receives and bounds the actual request stream. Vercel supplies `VERCEL=1`; do not configure a client-side imitation of the platform.

The function requires the request Host to equal the configured frontend host. Preview aliases therefore cannot use production API authority automatically. A separate preview/staging deployment needs its own browser origin, backend, secrets and database rather than reuse production cookies/authority.

Vercel-to-Oracle requests verify the public certificate and use one fixed HTTPS destination; the function never follows redirects, chooses an upstream from a browser header or query, or retries a mutation automatically. Requests and responses are bounded. Configure public DNS and Oracle ingress so the API hostname reaches only this gateway's HTTPS listener. Certificate issuance/renewal and any HTTP redirect port policy remain explicit operator responsibilities.

## Monitoring and live acceptance

Configure the read-only operations checker with:

```bash
export PAMOFI_MONITOR_ORIGIN=https://api.your-domain.example
export PAMOFI_MONITOR_FRONTEND_ORIGIN=https://your-frontend.example
node pamofi-backend/infra/operations/check.mjs --queues
```

Also supply the operations checker's existing rendered Compose file/project inputs as documented in [operations](../operations/README.md). It uses no proxy credential: Oracle's health and direct-access denial are checked separately from the frontend's anonymous API response and private-route denial. It rejects HTML/SPA fallbacks, unexpected cookies and redirects.

Before calling the split deployment live, verify the actual public DNS and certificate chain, the exact production frontend host, unauthenticated Oracle API denial, customer creation/retry and cross-device handoff, secure cookies and logout, first administrator/agent MFA and approvals, cash sale/receipt/redemption/usage, and distinct caller rate-limit identities through real Vercel edge metadata. The local lab supplies synthetic edge-owned IP metadata; live acceptance must establish the platform's actual trusted-header behavior.

This deployment overlay does not establish router reachability, private RADIUS routing, live accounting, payment-provider approval or a public mobile release. Those remain the independent site/provider/device acceptance procedures.

## Executable software qualification

Run the small offline suite with Node 24 and OpenSSL:

```bash
node --test pamofi-backend/infra/production/vercel-config.test.mjs
```

After independently building all five services and the web project, run the full split-host lab on Linux with a local Unix-socket Docker daemon, Docker Compose, Node 24 and OpenSSL:

```bash
node pamofi-backend/infra/production/run-vercel-lab.mjs
```

The runner creates only an owned disposable project, images, labeled volume, private synthetic secret directory, separate TLS hostnames and ephemeral loopback listeners. It uses the actual Vercel handler, the actual Oracle nginx startup/template and private web allowlist, the five real services, all actual migrations/grants, and a real one-time administrator bootstrap. Transport adapters only route the test DNS names to loopback and trust the test CA; TLS verification stays enabled.

Assertions cover rejected malformed startup credentials/hostnames, restrictive rendered-file permissions, API token authentication and direct bypass attempts, canonical IPv4/IPv6 and forged ordinary headers, preserved query/body/idempotency, separate browser/Oracle origin checks, multi-cookie MFA and logout, real administrator approval of a new agent, stock allocation, cash attestation, idempotent sale, receipt pairing, voucher redemption and customer usage. Two callers through the same proxy listener have independent backend limits. The dual-origin monitor probes the actual TLS endpoints without a credential. The lab also retains the existing private authorization and persistent-volume teardown proofs.

Run `run-lab.mjs` separately for the unchanged default same-host path, including the full read-only operations CLI and three runtime aggregate queries. Both runners clean only their own project/labels/files. A source review, syntax check or passing offline test is not a substitute for the full Docker/TLS result, and either local lab is distinct from live Vercel/Oracle/device qualification.
