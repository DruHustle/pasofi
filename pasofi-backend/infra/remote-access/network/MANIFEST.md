# Private owner target manifest, schema 1

`owner-targets.json` is produced by `buildPlan()` in `plan.mjs` and consumed by
`operator-mac/check_remote.py`. It is a regular owner-controlled `0600` file in
the generated `0700` directory outside Git. It contains expected inventory,
not credentials or proof of a live session. Its status remains `prepared-only`
even when the read-only checker produces a separate observation report.

Only these top-level fields are present:

| Field | Contract |
| --- | --- |
| `schemaVersion` | Integer `1`. |
| `kind` | Literal `pasofi-owner-management`. |
| `status` | Literal `prepared-only`. |
| `planId` | Stable lowercase ID, `[a-z][a-z0-9-]{0,31}`. |
| `expectedTailscaleLogin` | Exact observed login, at most 160 ASCII characters; email-style domain labels or literal `github` / `passkey`. No normalization. |
| `expectedHubNodeId` | Observed Tailscale StableNodeID, `[A-Za-z0-9_-]{1,128}`. Not a node public key, peer map key, hostname or guessed alias. |
| `requiredRoutes` | Exactly the ordered `targets[].address + "/32"` list. Does not include unrelated pre-existing hub advertisements. |
| `targets` | 1–128 entries, ordered gateway then its downstream devices. |

Each target has exactly these fields:

| Field | Contract |
| --- | --- |
| `id`, `gatewayId` | Stable IDs using the same ID pattern. IDs are globally unique. Every gateway ID identifies a gateway entry. |
| `name` | Nonblank well-formed UTF-8 text, 1–80 bytes, without control characters. |
| `role` | `gateway` or `downstream`. A gateway has `id === gatewayId`. |
| `vendor` | `mikrotik`, `tenda`, `mercusys` or `other`; gateways are `mikrotik`. |
| `address` | Canonical RFC1918 IPv4 literal. Globally unique. Gateway targets use their dedicated tunnel address. |
| `tcpPorts` | 1–4 unique integer values selected from 22, 80, 443 and 8291; generator sorts them. Selection is explicit. |
| `icmp` | Boolean; whether echo diagnostics are intended. |
| `expectedIdentity` | Exactly `{kind,value}`. A gateway uses `serial`. Other targets use `serial` or `mac`. |
| `verifiedAt` | Operator observation time, calendar-valid UTC `YYYY-MM-DDTHH:MM:SSZ` or with exactly three millisecond digits before `Z`. |

Serials use `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. MACs use uppercase colon notation,
must be nonzero and unicast. The same case-insensitive `kind:value` physical
identity cannot appear twice. Two devices reporting a shared/nonunique serial
must be distinguished with independently observed unique management MACs.

The checker may probe only these destinations and permissions. It must not
discover additional devices, follow redirects to new destinations, install or
change VPN/routes, hold device credentials, run SSH commands, or infer physical
identity from a successful port/HTTP response. An authenticated native-device
identity check remains a separate acceptance step.
