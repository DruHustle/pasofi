# Optional private RouterOS reconciler

For customer service commissioning, follow the [cash hotspot launch runbook](../../docs/CASH_HOTSPOT_LAUNCH.md). This overlay is optional in the source stack, but the managed paid-session workflow needs its qualified reconciler to prove Stop → independent absence → closed → reconnect. The separate central Routers administration workspace does not establish that this worker is active.

`router-control.compose.yaml` wires the existing network service's RouterOS reconciler into the production stack. The base and RADIUS overlay still leave `NETWORK_RECONCILER_ENABLED=false`. This optional file supplies the missing credential/CA mounts and activation input; it creates no router account, certificate, tunnel or new authentication mechanism.

## PasoFi controller scope

For the current deployment, the only routers eligible for this controller are **K0** (Kuwadzana captive-portal/RADIUS gateway) and **G0** (Goromonzi captive-portal/RADIUS gateway). **K1 is an access point only and must not be enrolled, assigned a controller account, or included in `routers.json`.** The production registry must contain exactly one independently qualified row for K0 and one for G0 before enabling the overlay. Router identity labels in old `K1`/`site-01` files are not authoritative: the live G0 readback identifies `10.77.254.2` as G0, while the live K0 endpoint is `10.78.254.4`.

As of 20 November 2026, neither gateway has a qualified controller enrollment in this runtime. K0's `/radius` list is empty and its HotSpot profiles do not use RADIUS; trial login remains enabled. After the owner's confirmation, K0's `www-ssl` REST listener is staged on TCP443 with the existing `pasofi-k0-portal` certificate, limited by RouterOS service and firewall to Oracle's owner-tunnel address `10.78.254.1/32`; the unused `reverse-proxy` listener is disabled. RouterOS Safe Mode remains on until private endpoint verification succeeds, so the change is not yet committed. The existing router-management certificate is valid for the legacy certificate name `hotspot.pasofi.onesa.eu`, not the K0 tunnel IP. The controller overlay now maps that hostname to `10.78.254.4` only inside the network container, keeping public DNS pointed at the Oracle gateway while allowing hostname validation and a private pinned HTTPS request. This source change still needs deployment and a strict-TLS request from Oracle before Safe Mode can be committed. The customer-facing hostname is `hotspot.pasofi.mobile.onesa.eu`; its public A record now points directly to the Oracle gateway, but the public TLS certificate has not been qualified for the new name; the earlier request to the old public hostname returned `ERR_CERT_COMMON_NAME_INVALID`, and the optional portal overlay is not live. Do not disable certificate checks or point public DNS at the private tunnel. K0's live DNS readback also showed `hotspot.pasofi.onesa.eu` dynamically bound to the management bridge (`192.168.88.1`) while `pfi-guest20` is bound to guest VLAN20 (`10.20.0.1`) under the legacy `hotspot.pamofi.onesa.eu` name. The management HotSpot must be disabled for customers and the guest profile moved to `login.pasofi.mobile.onesa.eu` with a RouterOS certificate whose SAN retains the private controller name and covers `login.pasofi.mobile.onesa.eu` before customer admission; the separate public gateway certificate covers `hotspot.pasofi.mobile.onesa.eu`. G0 has a REST HTTPS endpoint and an IP-matching certificate on its legacy site tunnel, but the endpoint is restricted to the legacy Oracle source address; its only visible controller-style account is a disabled `pfi-k1-reconciler` account limited to that legacy source. Do not enable or reuse that stale K1-named account. G0's RADIUS client also carries a legacy `site01` label and requires an independently matched Goromonzi NAS registration. These are live readback observations, not desired values.

Keep `PAMOFI_ROUTER_CONTROL_QUALIFIED=false` and the reconciler off until K0 and G0 have separately verified NAS identities, restricted per-device accounts, private HTTPS endpoints reachable from the network container's actual post-NAT source, trusted certificates, and tested disconnect/re-query paths. This controller gate is a customer-session safety dependency; it does not authorize sales or payments.

## Prepared material

Prepare a new operator-owned `0700` directory outside the checkout and set `PAMOFI_ROUTER_CONTROL_DIR` to its absolute path. Keep these files there:

| Path | Mode | Content |
| --- | --- | --- |
| `routers.json` | `0444` | Private array using the existing `nasId`, `url`, `username`, `password` and `caFile` runtime fields |
| `ca/` | `0755` or `0555` | Directory containing only the referenced public certificates |
| `ca/<nas-uuid>.pem` | `0444` | One current public trust certificate for that device |

The private parent protects host access. Compose mounts the JSON **individually**, only into the network service, so its non-root UID can read it. The separate read-only directory mount contains public certificates only. Never place a CA signing key or router private key there.

Use `router-control.example.json` as a field reference; its placeholders deliberately fail validation. Supply credentials privately on Oracle using an existing restricted per-device RouterOS service account. Each `nasId` must be the exact lowercase UUID in the owned NAS registry. Each `caFile` must be `/run/pamofi/routeros-ca/<nas-uuid>.pem`. The overlay's `extra_hosts` entry for K0 is intentionally private to the network service container; the K0 row in `routers.json` must use `https://hotspot.pasofi.onesa.eu/rest/` so TLS identity validation agrees with the router certificate. If K0's reviewed owner-tunnel address changes, update both the mapping and router allowlist in the same reviewed change. Do not copy this mapping to public DNS or other services.

The URL must be the exact `https://<reviewed-router-host>/rest/` on TCP443. An IP literal must be the selected RFC1918 IPv4 tunnel address; a DNS hostname must resolve to exactly one reviewed RFC1918 IPv4 address. At runtime, each RouterOS request resolves the host, rejects public, IPv6, mixed or multiple answers, and pins the validated address for that HTTPS request to prevent a second DNS lookup from rebinding the credential-bearing connection. The served certificate must match the URL's hostname or IP SAN. The offline preflight checks material, not DNS resolution, the live certificate or account privileges.

```bash
export PAMOFI_ROUTER_CONTROL_DIR=/absolute/protected/router-control
export PAMOFI_ROUTER_CONTROL_QUALIFIED=false
node pasofi-backend/infra/production/preflight-router-control.mjs
```

The output remains `prepared-only` and prints no credential values. It checks the exact existing runtime schema, unique NAS identifiers and RouterOS endpoint URLs, HTTPS scope, private parent, readable individual files, absence of private keys/unreferenced files in the CA mount, and current public certificates. Source/example files contain no deployment credentials.

## Explicit deployment input

Include this overlay after the selected production/Vercel/RADIUS files on every relevant Compose command:

```bash
docker compose \
  -f pasofi-backend/infra/production/compose.yaml \
  -f pasofi-backend/infra/production/router-control.compose.yaml \
  config --quiet
```

The required `PAMOFI_ROUTER_CONTROL_QUALIFIED` input maps directly to the existing `NETWORK_RECONCILER_ENABLED` switch. Keep it `false` while preparing. Only the exact value `true` enables the existing worker; use it during an explicitly reviewed controlled activation after the selected device, credentials, certificates, tunnel and recovery path are ready. This source change does not perform that activation.

The overlay preserves the private service/database networks and adds the agreed `router_control` bridge with explicit IPv4 NAT/masquerading. That provides an outbound path through the host's reviewed WireGuard route. [The site-link firewall](../site-link/README.md) must still restrict post-SNAT traffic to the selected Oracle/router tunnel addresses and TCP443. No network service port or router management port is published. When combining with [RADIUS](../radius-production/README.md), both files declare the same bridge options.

The existing service uses verified TLS and its existing HTTP Basic credential contract for `/rest/ip/hotspot/active`. It queries only the selected credential's sessions, deletes only returned session identifiers, and independently re-queries before treating termination as observed. Missing authority, TLS failure, timeout or ambiguous state remains unavailable/uncertain; this overlay changes no accounting or disconnect logic.

## Software checks and remaining acceptance

```bash
node --test pasofi-backend/infra/production/router-control-config.test.mjs
node pasofi-backend/infra/production/run-lab.mjs
```

The offline tests validate the real PEM/file contract and reject malformed scope, credential shape, symlinks, unsafe modes and a CA mount containing private keys. The production lab renders both disabled and enabled configurations with disposable material and checks network/mount ownership without starting router control or contacting any device. The network service's existing `routeros.test.mjs` separately tests actual TLS, credential forwarding, redirects, timeouts, foreign-session rejection and post-delete re-query against its local fixture.

Physical acceptance remains deferred: device identity and least-privilege account, current certificate/hostname, private DNS/routing, actual source after NAT, disconnect plus re-query, accounting/reboot/outage behavior and local recovery. A prepared configuration or passing software test does not establish those live results.
