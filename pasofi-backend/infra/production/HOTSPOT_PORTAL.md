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

Before enabling the overlay, add the exact gateway HTTPS origin to
`PASOFI_PUBLIC_ORIGIN_ALIASES` for identity and prepaid. Retain the existing
canonical origin and aliases. Validate the certificate and dedicated-IP owner.
Run `preflight-vercel.mjs` with `PASOFI_HOTSPOT_PORTAL=true`,
`PASOFI_HOTSPOT_PUBLIC_ORIGIN=https://your-gateway-host`, and the same assets,
origins and secrets environment before starting Compose. It rejects a missing
origin alias, mismatched certificate or ordinary non-portal build. This does
not verify DNS ownership or replace the live TLS and browser acceptance tests.
This browser origin has its own host-only cookies; it does not inherit a
customer's Vercel session. Normal recovery and explicit account handoff apply.

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
