# Canonical Pasofi website

The selected main website is **https://pasofi.mobile.onesa.eu**. It uses the
existing Vercel `pasofi` project and independent `pasofi-frontend/web` build.
The Oracle API is **https://api.pasofi.mobile.onesa.eu**; the earlier
`https://api.pasofi.onesa.eu` was retired on 2026-11-23 (see
[API hostname move](#api-hostname-move)). This is a hostname handoff; it does not integrate Pasofi into Onesa Mobile or change
payment, customer-network, native-qualification or staff-access gates.

## Exact existing configuration contract

| Boundary | Existing setting | Final reviewed public value |
| --- | --- | --- |
| Vercel primary browser origin | `PAMOFI_PUBLIC_ORIGIN` | `https://pasofi.mobile.onesa.eu` |
| Vercel accepted website aliases | `PASOFI_PUBLIC_ORIGIN_ALIASES` | `["https://pasofi.onesa.eu","https://pamofi.onesa.eu"]` |
| Vercel upstream API | `PAMOFI_ORACLE_API_ORIGIN` | `https://api.pasofi.mobile.onesa.eu` |
| Onesa split Compose primary | `PAMOFI_PUBLIC_ORIGIN` → services' `PUBLIC_ORIGIN` | Same new canonical website |
| Onesa split Compose aliases | `PASOFI_PUBLIC_ORIGIN_ALIASES` → identity/prepaid `PUBLIC_ORIGIN_ALIASES` | Both earlier website aliases plus any existing qualified gateway HTTPS origin; reconcile the actual bounded list |

These are public origin values, not credentials. Preserve the existing proxy
token, secret files, app identities, persistent data, API hostname and all
feature flags. The table describes the reviewed destination state, not proof
that the running deployment already has it. Inspect the installed model before
updating its existing inputs; do not replace a qualified runtime with a generic
base Compose file or copy historical configuration over current private state.

The Vercel proxy accepts one primary origin and at most three explicit aliases.
It validates the request's actual Host. Mutations and native calls require a
matching Origin; ordinary GET/HEAD requests may omit it, but any supplied Origin
must match that host. The proxy forwards Origin unchanged to the API. Identity and prepaid independently
enforce their bounded origin sets. Adding a DNS name alone is insufficient.
Keep old origins accepted while introducing the new one, then change the
primary after the new route is ready. Do not add wildcards, spoof an origin or
relax cookie/CORS rules to make a request pass.

The maintained [hotspot contract](../pasofi-backend/infra/production/HOTSPOT_PORTAL.md) also requires the
qualified gateway HTTPS origin in identity/prepaid's aliases. Preserve any
actual existing qualified gateway alias when reconciling that list; do not
replace it with only the two websites. With the new website as primary, the two
older websites leave one of the three alias slots for that gateway. If the
observed list needs more slots, stop and resolve the concrete conflict through
the maintained contract instead of dropping a qualified origin or raising the
bound silently. The Vercel website aliases do not need a gateway hostname added
merely because the API accepts that separately qualified hotspot origin.

## User sessions, generated links and native clients

Browser sessions use Secure, HttpOnly, host-only `__Host-` cookies. A session on
an earlier hostname is not copied to the new hostname. Users use the existing
normal sign-in, explicit recovery or one-use handoff flow. Preserve old aliases
during acceptance; do not automatically redirect authenticated mutation routes.

Identity's staff-recovery email uses `PUBLIC_ORIGIN`. Prepaid generates invoice
SMS links from it, and notification validates those links against its own
`PUBLIC_ORIGIN`. Their primary values must agree before ordinary future
delivery uses the new address. This handoff neither sends a test message nor
enables a disabled delivery provider. The Stripe callback stays on the existing
API host; native Stripe's app return scheme also remains unchanged. The dormant
Pesepay adapter is not an active hostname dependency.

Web requests and normal navigation are relative to the current origin; the
public HTML declares the new canonical address. The web package has no PWA
manifest or service-worker scope that needs moving. Hotspot form origins and
their CSP remain the existing separately qualified hotspot hosts.

For a later qualified native release, `VITE_PAMOFI_API_BASE_URL` must use the
new **frontend** origin, not the private Oracle API. Capacitor sync binds this
public value into the native plugin; the cookie store is partitioned by origin.
An existing installed app therefore keeps its bundled host and private session
until an independently accepted new build is distributed. Keep the legacy
aliases to support it. The current API-unconfigured preview builds and native
enablement flags remain unchanged. See [native connection](../NATIVE_CUSTOMER_CONNECTION.md).

## Ordered handoff and acceptance

1. Add the exact new hostname to the existing Vercel project, obtain its normal
   DNS instructions, and configure the authoritative DNS provider. Verify the
   exact hostname's TLS certificate; do not assume an existing parent wildcard
   covers this deeper name. Keep both older website aliases.
2. Reconcile the actual installed public-origin values at both proxy and API
   boundaries, preserving current inputs, secrets, container roles and delivery
   gates. Use the supported existing alias mechanism during the transition.
3. After exact-source qualification, publish the frontend once through the
   existing project and verify the new alias points to that accepted source.
   The repository workflows verify and package artifacts; they do not themselves
   publish production. Confirm the actual project integration or use the normal
   controlled release without assuming a merge deployed it.
4. Verify public page/assets/canonical link, private no-store API responses,
   the normal account/session boundary and the retained old aliases. Keep
   read-only observation separate from any account, payment, email or network
   action. Record the current deployment and rollback identity.

Completion requires actual provider and application readbacks. Source changes
alone do not establish that a domain, origin configuration or session has moved.

## Preserve the accepted origin in later releases

The 2026-11-09 origin handoff left the five application services on their same
qualified images with the new primary. Identity/prepaid retain both earlier
websites and the observed `https://api.pasofi.onesa.eu` gateway alias (the retired
API name, harmless until the next release removes it; see
[API hostname move](#api-hostname-move)). Preserve
the current private Compose input copies and candidate overlay referenced by
the running containers' labels; they are current deployment inputs, not
disposable staging files. Do not overwrite the historical baseline or deploy
from it alone, because it contains the earlier per-service primary values.

Before a later application release, use the maintained per-service
`--capture-baseline` path to verify and record the actual current inputs into a
new private baseline. It supports the explicit `/dev/null` environment-file
label as a verified empty device, while retaining exact Compose hashes and
full runtime-environment, mount, network and database identity checks. It does
not treat an absent or arbitrary environment file as empty. Baseline capture
does not apply a release, and an old baseline or recovery receipt is not
relabelled as current acceptance. Keep the canonical primary and the complete
bounded alias list through the next normal release plan.

## API hostname move

PasoFi hostnames live under `pasofi.mobile.onesa.eu`. The Oracle API moved from
`api.pasofi.onesa.eu` to `api.pasofi.mobile.onesa.eu` on 2026-11-23. The new name
is a DNS-only Cloudflare A record to the dedicated Oracle gateway, covered by the
`pasofi-public` certificate lineage together with `hotspot.pasofi.mobile.onesa.eu`.
The router-local login name `hotspot.pasofi.onesa.eu` is separate and unchanged.

The gateway has a single HTTPS server and authenticates the Vercel proxy by
token, not by Host, and identity/prepaid check the forwarded browser `Origin`,
not the API Host. Moving a consumer to the new name therefore needs no service
release. Each consumer was moved and read back:

1. Vercel `PAMOFI_ORACLE_API_ORIGIN` → `https://api.pasofi.mobile.onesa.eu`,
   followed by a production redeploy (environment changes apply only to new
   deployments).
2. Field routers' WireGuard peer endpoint → `api.pasofi.mobile.onesa.eu` (G0;
   K0 has no service tunnel and K1 connects by IP).
3. Host monitoring (`pamofi-health-check`) and the Onesa Portal infrastructure
   monitor → `https://api.pasofi.mobile.onesa.eu/health/live`.
4. Still open for the next normal release plan: set the gateway's
   `PAMOFI_PUBLIC_HOST` to the new name and drop `https://api.pasofi.onesa.eu`
   from identity/prepaid `PUBLIC_ORIGIN_ALIASES`. It only selects the HTTP-redirect host; TCP 80 is opened solely for
   certificate validation.

`PASOFI_ONESA_AUDIENCE=https://api.pasofi.onesa.eu` is the Auth0 API identifier,
not a hostname. Auth0 identifiers are immutable, so it stays unchanged unless the
owner chooses a coordinated delete-and-recreate of the PasoFi API.

The legacy name was then retired: it was removed from the certificate and its DNS
record deleted. Nothing in the Onesa Portal collector, Cloudflare Workers or the
routers referenced it at that point.
