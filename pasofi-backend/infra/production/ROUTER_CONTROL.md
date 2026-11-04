# Optional private RouterOS reconciler

`router-control.compose.yaml` wires the existing network service's RouterOS reconciler into the production stack. The base and RADIUS overlay still leave `NETWORK_RECONCILER_ENABLED=false`. This optional file supplies the missing credential/CA mounts and activation input; it creates no router account, certificate, tunnel or new authentication mechanism.

## Prepared material

Prepare a new operator-owned `0700` directory outside the checkout and set `PAMOFI_ROUTER_CONTROL_DIR` to its absolute path. Keep these files there:

| Path | Mode | Content |
| --- | --- | --- |
| `routers.json` | `0444` | Private array using the existing `nasId`, `url`, `username`, `password` and `caFile` runtime fields |
| `ca/` | `0755` or `0555` | Directory containing only the referenced public certificates |
| `ca/<nas-uuid>.pem` | `0444` | One current public trust certificate for that device |

The private parent protects host access. Compose mounts the JSON **individually**, only into the network service, so its non-root UID can read it. The separate read-only directory mount contains public certificates only. Never place a CA signing key or router private key there.

Use `router-control.example.json` as a field reference; its placeholders deliberately fail validation. Supply credentials privately on Oracle using an existing restricted per-device RouterOS service account. Each `nasId` must be the exact lowercase UUID in the owned NAS registry. Each `caFile` must be `/run/pamofi/routeros-ca/<nas-uuid>.pem`.

The URL must be the exact `https://<reviewed-router-host>/rest/` on TCP443. An IP literal must be the selected private IPv4 tunnel address; a DNS hostname must resolve to that reviewed address. The served certificate must match the URL's hostname or IP SAN. The offline preflight checks material, not DNS resolution, the live certificate or account privileges.

```bash
export PAMOFI_ROUTER_CONTROL_DIR=/absolute/protected/router-control
export PAMOFI_ROUTER_CONTROL_QUALIFIED=false
node pasofi-backend/infra/production/preflight-router-control.mjs
```

The output remains `prepared-only` and prints no credential values. It checks the exact existing runtime schema, unique NAS identifiers, HTTPS scope, private parent, readable individual files, absence of private keys/unreferenced files in the CA mount, and current public certificates. Source/example files contain no deployment credentials.

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
