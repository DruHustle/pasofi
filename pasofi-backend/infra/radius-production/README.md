# Production RADIUS software for the Oracle backend

This is an explicit opt-in overlay for `infra/production/compose.yaml`. It adds
the pinned FreeRADIUS server and the existing network service's separate mTLS
RADIUS authority. The default production stack still keeps customer network and
RADIUS activation disabled. Preparing this software does not configure a
physical hotspot or establish commercial readiness.

## Runtime and trust

- `radius` uses the same immutable FreeRADIUS 3.2.9 image qualified by the existing
  packet laboratory. UDP 1812/1813 are published only on the supplied private
  Oracle WireGuard address. Startup refuses an unqualified configuration, a
  wildcard/public/loopback bind, or a bind that differs from the prepared files.
- Each NAS has an exact source `/32`, its own cryptographically random shared
  secret and a fixed client shortname. Access requests require a Message-
  Authenticator; proxy-state restrictions remain enabled. Packet-supplied
  `NAS-Identifier` does not select the trusted NAS identity.
- `radius-api` has no host port. FreeRADIUS calls it through HTTPS with verified
  CA/hostname and a client certificate. The authority independently requires
  that certificate's pinned SHA256 fingerprint, then resolves the registered NAS.
- FreeRADIUS has a dedicated ordinary `radius_ingress` bridge for published UDP
  replies and an internal `radius_transport` bridge for the authority. Attaching
  it only to an internal bridge would omit the return route to the NAS. The
  network service separately joins `router_control` for outbound RouterOS HTTPS.
  Internal database/ledger traffic retains its existing private networks.
- The authority uses only the network database **runtime** role and a scoped
  service token over the existing private HTTPS connection to prepaid. It has
  no direct prepaid database access and no migration credential.
- Authentication remains unavailable when the authority fails; an accounting
  response is sent only after the authority acknowledges the request. Actual
  durable ledger behavior remains the responsibility of the existing network/
  prepaid services and their full integration tests.

## Prepare material and NAS registration

Choose the exact site UUID already used for staff inventory/sales, a fresh NAS
UUID, the router's service-tunnel `/32`, and the actual HTTPS HotSpot login URL.
The example intentionally contains invalid placeholders. Never reuse laboratory
identifiers, keys, shared secrets or certificates.

```sh
node pasofi-backend/infra/radius-production/prepare.mjs \
  /protected/selected-nas-registry.json \
  /protected/new-radius-material --new-install-only
```

Node and OpenSSL are required. The command creates a new mode0700 directory
outside the repository, independent NAS secrets, a separate private transport
CA, client/server certificates, the client fingerprint, and exact FreeRADIUS
client configuration. No secret values are printed, existing output is refused,
and no router, database, cloud resource or running service is changed.

Runtime files are mode0444 **inside that private host directory** so separately
unprivileged containers can read their individual bind mounts. The directory is
never mounted. NAS secret files, the CA signing key and review records stay
mode0600. Only the client container receives its client private key; only the
authority receives its server private key. The CA signing key is never mounted.
Keep it with the protected recovery material. Generated transport certificates
have a **90-day lifetime**; arrange expiry monitoring and an explicitly reviewed
certificate/fingerprint replacement before activation. Re-running preparation
is not an in-place rotation and cannot overwrite a live set.

`nas-registration.sql.review` contains explicit INSERTs with `enabled=false`.
Review and execute it using the network migration/owner role after migrations;
runtime roles cannot register NASes. It deliberately has no conflict-upsert, so
a mismatched existing registration fails instead of silently changing ownership.
Confirm the matching prepaid site separately. Enabling the selected NAS and
customer-network capability belongs to controlled physical acceptance later.

## Router client preparation

`router-plan.mjs` creates a review file for one **disabled** RouterOS RADIUS
client using the site's already generated secret. Provide the secret as a
private mode-0600 regular file containing its 64 lowercase hexadecimal
characters, optionally followed by a single newline. The generated review file contains a
SHA-512 digest and references `pfi-radius-<site>.secret`; it never contains the
secret itself. Transfer that protected secret file to the selected router only
through an approved private path and remove its temporary copies after import.

```sh
node pasofi-backend/infra/radius-production/router-plan.mjs \
  site01 10.77.254.1 10.77.254.2 /protected/pfi-radius-site01.secret \
  /protected/new-router-radius-review.rsc
node --test pasofi-backend/infra/radius-production/router-plan.test.mjs
```

Inspect the exact router and RADIUS state, check the public-only review file in
RouterOS using `verbose=yes dry-run`, and use Safe Mode for any actual import.
The client remains disabled. Never print the secret or run a verbose import
that expands it. A protected file, a disabled client or a successful syntax
check does not qualify authentication, accounting, HTTPS or customer access.

## Deployment overlay

Use the qualified base production environment/image digests and secret files,
then supply the non-secret values shown in `.env.example`. Compose paths are
resolved relative to the first file:

```sh
docker compose \
  -f pasofi-backend/infra/production/compose.yaml \
  -f pasofi-backend/infra/radius-production/compose.yaml \
  --profile radius-qualified config
```

Combine with the Vercel/Oracle overlay when deploying that hosting split. Review
the rendered configuration before starting it. The exact Oracle VM, network
addresses, certificates, NAS identity and private files are deployment inputs;
no existing Onesa VM is assumed to belong to PamoFi.

Both new services use the `radius-qualified` profile and require an explicit
`PAMOFI_RADIUS_QUALIFIED=true` for controlled activation. Applying the overlay
with false does not turn the service on. `PAMOFI_CUSTOMER_NETWORK_ENABLED`
defaults to false, even when the RADIUS transport is enabled. Customer credential
issuance is therefore a separate deliberate step. Keep the default gates closed
until the selected site's controlled acceptance is ready.

The [site-link plan](../site-link/README.md) supplies the outbound MikroTik VPN
and the narrow Oracle firewall scope. Docker DNAT/SNAT and source preservation
must be checked on the chosen host: the FreeRADIUS client must see the router's
tunnel address, never an unrelated Docker gateway. OCI security rules expose
only the encrypted WireGuard transport; RADIUS ports remain private. Do not use
host networking, wildcard port publication, a broad NAS subnet or default
shared secrets.

Use a qualified Linux Docker Engine 28+ deployment. The two normal bridges use
explicit `nat` mode. Docker source NAT gives outbound management traffic the
Oracle WireGuard address; the site's post-SNAT rule then admits only TCP 443 to
the selected router `/32`. The pre-DNAT rule also rejects traffic addressed to
the RADIUS tunnel bind if it arrives on another host interface. These guards
must be integrated before controlled activation; a private bind alone is not an
interface firewall. The source generator makes no host firewall changes.

The RouterOS HTTPS reconciliation worker remains separately disabled. The
optional [router-control overlay](../production/router-control.compose.yaml)
supplies its protected `ROUTEROS_ROUTERS_FILE` and per-device CA mount; follow
[its preparation guide](../production/ROUTER_CONTROL.md) before enabling it.
Qualify disconnect/re-query/accounting behavior with the actual per-NAS
restricted credentials and trusted device certificates. These overlays do not
create or weaken router accounts or certificates.

For operations checks, set `PAMOFI_OPERATIONS_RADIUS_BIND` to the same inspected
private address. The checker can then require `radius` and `radius-api`, a
healthy authority, the exact UDP1812/1813 host binding and no exposed authority
port. A running TCP listener is only process readiness; accounting/credit
correctness and physical enforcement require the acceptance tests below.

## HotSpot authentication contract

The implemented authority expects PAP's RADIUS `User-Password` attribute and a
stable `Acct-Session-Id`; authenticated Access-Requests also require
`Message-Authenticator`. The customer flow uses an exact registered **HTTPS**
login URL and an HTTPS credential POST. Configure and qualify the router's
HTTPS login profile/page so this produces the tested PAP request across the
encrypted WireGuard link. RouterOS's default CHAP login flow cannot be assumed
to satisfy this contract. CHAP, EAP and MSCHAP are not implemented here and must
be rejected; do not enable a plaintext HTTP-PAP fallback or a trial/MAC/cookie
bypass to make a failed login appear successful.

Physical acceptance must inspect actual RADIUS attributes and verify that a
valid credential succeeds, expired/wrong/NAS-mismatched credentials fail, and
unsupported authentication or fallback modes do not grant access. Confirm
upload-only and download-only accounting against known transfers as well as
total usage before accepting customer-facing direction labels. See the
[MikroTik RADIUS contract](https://help.mikrotik.com/docs/spaces/ROS/pages/328097/RADIUS)
and [HotSpot configuration](https://help.mikrotik.com/docs/spaces/ROS/pages/56459266/HotSpot+-+Captive+portal).

## Software verification

### Onesa first-site runtime check

`onesa-radius-ensure.py` and the accompanying systemd service/timer are pinned
to the reviewed Onesa first-site containers, image IDs, private port bindings,
Docker networks and tunnel. The check refuses changed definitions, requires
the site guard and WireGuard services, checks the private RADIUS certificates
for 30 days' remaining life, starts stopped reviewed containers and confirms
the authority's health and exact UDP listeners. Failures use the existing
PamoFi alert service. It does not test a NAS packet or customer access.

The timer intentionally restarts those exact stopped containers every five
minutes. Disable and stop the timer before planned RADIUS shutdown or rollback.
Requalify and update the pinned definitions before replacing either image,
secret directory, network or tunnel. Verify startup across an actual host
restart before claiming boot recovery.

```sh
python3 pasofi-backend/infra/radius-production/onesa-radius-ensure.test.py
```

```sh
node --test pasofi-backend/infra/radius-production/config.test.mjs
node pasofi-backend/infra/radius-production/run-lab.mjs
```

The first suite checks strict identity/secret validation, disabled registration,
private files/no overwrite, actual CA-signed certificates/fingerprint, production
qualification and runtime-role enforcement. The Docker laboratory renders the
**actual production overlay**, checks its exact private host bindings, custom
role prefix, and preserved closed customer/reconciler gates, then runs its
pinned FreeRADIUS configuration with real UDP packets **from a different bridge
through the published host ports**. A routed synthetic NAS bridge preserves the
NAS source `/32`; its private gateway stands in for the Oracle tunnel address.
The test verifies accepted authentication, source identity despite spoofed NAS
attributes, wrong secret, unknown source, unsupported CHAP, wrong client pin,
wrong CA, missing client certificate, accounting rejection and authority
outage. It executes the live entrypoint's qualification/bind refusal paths.

A network-shaped container joins internal service/database networks plus the
normal control bridge. It reaches an independently CA-verified HTTPS NAS on the
separate routed network, and the NAS must observe the synthetic Oracle address
as the source. The fixture publishes no host TCP port and the authority stays
unexposed. All fixture addresses, certificates, bridge networks and containers
belong to a unique disposable project. The lab requires a local Unix-socket,
rootful Linux Docker Engine 28+ daemon, ignores inherited Compose project/file
selection, and removes its owned resources on completion or interruption.

That laboratory uses an explicitly isolated **transport authority fixture**,
with no real ledger/customer/provider access. The existing
`pasofi-radius/lab/run-lab.sh` separately verifies actual network/prepaid/database
transactions, 64-bit accounting and conservative reservation handling. Together
they verify software behavior; neither connects to Starlink, runs RouterOS, or
proves physical byte/time limits, reboot handling, Wi-Fi isolation or capacity.
Those physical tests are intentionally deferred until the software work is done.

Docker references: [published ports, gateway modes and source NAT](https://docs.docker.com/engine/network/port-publishing/)
and [bridge network isolation](https://docs.docker.com/engine/network/drivers/bridge/).
