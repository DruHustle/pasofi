# Dedicated HTTPS entry for captive customers

The Vercel app uses shared CDN IPs. Allowing those entire IPs before hotspot
authentication can also allow unrelated hosted sites. The optional gateway
portal serves the same frontend on the gateway's dedicated public HTTPS IP,
including after a welcome trial expires. It does not enable general Internet
access, change the trial allowance, or qualify a paid connection.

Build web with `VITE_PASOFI_HOTSPOT_PORTAL=1 npm run build`. The output contains a
build marker and uses same-origin `/portal-api/` requests. Mount this immutable
build with `hotspot-portal.compose.yaml` after the existing Vercel overlay; set
`PASOFI_HOTSPOT_WEB_DIR` to its absolute path. Startup refuses missing assets,
a missing marker, or an invalid activation flag. Ordinary Vercel builds and
the default gateway remain unchanged when the overlay is absent.

Use `hotspot.pasofi.mobile.onesa.eu` for the hosted captive PasoFi page and point it at the gateway's dedicated public IP. Use `login.pasofi.mobile.onesa.eu` only for the RouterOS local login; K0's HotSpot DNS must answer that name with its guest interface address. Set `PASOFI_HOTSPOT_PUBLIC_HOST=hotspot.pasofi.mobile.onesa.eu`
and `PASOFI_HOTSPOT_PUBLIC_ORIGIN=https://hotspot.pasofi.mobile.onesa.eu`. Add that
exact HTTPS origin to `PASOFI_PUBLIC_ORIGIN_ALIASES` for identity and prepaid.
Retain the existing canonical origin and aliases. The mounted public
certificate must cover both the canonical Oracle API hostname and the hosted
portal hostname. Nginx now renders both hostnames on its HTTP and HTTPS virtual host
and redirects HTTP to HTTPS on the requested qualified hostname. Validate the served certificate
chain and dedicated-IP ownership before enabling the overlay.
Run `preflight-vercel.mjs` with `PASOFI_HOTSPOT_PORTAL=true`,
`PASOFI_HOTSPOT_PUBLIC_ORIGIN=https://hotspot.pasofi.mobile.onesa.eu`,
`PASOFI_HOTSPOT_PUBLIC_HOST=hotspot.pasofi.mobile.onesa.eu`, and the same assets,
origins and secrets environment before starting Compose. It rejects a missing
origin alias, mismatched certificate or ordinary non-portal build. This does
not verify DNS ownership or replace the live TLS and browser acceptance tests.
This browser origin has its own host-only cookies; it does not inherit a
customer's Vercel session. Normal recovery and explicit account handoff apply.

Managed customer sign-in on the dedicated portal is optional. Pair the portal
overlay with the managed Onesa identity overlay. Register the exact
`https://hotspot.pasofi.mobile.onesa.eu/onesa-callback.html` callback on the
existing PasoFi confidential application and set
`PASOFI_ONESA_HOTSPOT_REDIRECT_URI` to that URL only after qualifying it. Keep the
existing canonical callback and approved PasoFi API audience. The captive build
exposes the callback page and script at exact routes and completes login through
`/portal-api/onesa/complete`. The browser resumes the same Connect, bundles or
voucher screen on the dedicated origin. Staff and native callbacks retain
their original bindings.

The Sign up action requires the Account service to register the fixed
`pasofi-hotspot` customer entry and return to the dedicated portal. Verify the
signup email, original browser return and subsequent product session before
enabling the dedicated callback. From an expired trial, independently test the
browser can reach the exact approved Account and Auth0 origins and their
required assets. Keep unrelated Internet, private addresses and management
ports outside this access. A successful callback alone does not establish the
pre-login network path.

The public portal entry strips caller-supplied proxy identity and uses nginx's
original socket address, even when a forged header was parsed by the shared
real-IP module. The existing private web route allowlist, application roles,
CSRF checks, request limits and secure cookies continue to apply. `/api/` still
requires Vercel's private credential. No credentials are placed in the portal
build, router HTML, URLs or diagnostic output. Unknown, private and secret paths
return 404; this is not an arbitrary forwarding proxy.

After server qualification, permit only TCP 443 to that gateway's dedicated IP
in the hotspot's IP walled garden and the guest forwarding policy. Retain all
private-network and IPv6 blocks and trial expiry. Change the welcome page's
app link to the qualified gateway HTTPS `/connect` URL. Test from an expired,
unauthenticated client: app, bundles and account flow work; unrelated Internet,
private addresses and management ports remain blocked. The router policy
activation and real-device acceptance are separate deployment steps.

`run-vercel-lab.mjs` first qualifies the original split deployment, then builds
and enables the portal against the same isolated real services. Its additional
checks cover trusted TLS and assets, API privacy, CSRF, idempotent creation,
host-only secure cookies, staff isolation, forged-header rate limits and logout.
The lab uses a new owned database volume and generated credentials, never
production data. It is not evidence of physical hotspot commissioning.
