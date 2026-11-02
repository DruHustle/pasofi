# Remote management: Tailscale clients and a WireGuard router tunnel

The inspected first router is a SMIPS hAP lite. It has native WireGuard, but it cannot run a normal Tailscale client or MikroTik Back to Home. The owner has confirmed there is **no always-on device at the site** to act as a local Tailscale subnet router.

The resulting design is:

- The MikroTik initiates an outbound WireGuard connection to the selected public Linux server. A 25-second keepalive maintains its upstream NAT mapping. The server is the only WireGuard peer.
- The server runs Tailscale and advertises only the router's dedicated management tunnel address as a `/32` subnet route.
- The owner's phone/laptop joins the same tailnet. The tailnet policy permits only the verified owner identity and the chosen management ports. The server forwards only that permitted traffic into the WireGuard interface.
- The router's existing home/customer LAN is not advertised. No default route or exit node is used. Router management, RADIUS, PostgreSQL and internal APIs have no direct public listener.

This requires no extra always-on computer beside the MikroTik. It does require one authenticated public server and a Tailscale account. No server has been selected or authenticated by this source change, and no route or access grant has been enabled.

## Prepare a concrete change

First inspect the chosen server's existing interfaces, routes, firewall manager, Tailscale state, UDP listeners and service dependencies. Preserve all existing applications and SSH recovery restrictions. Check that the proposed management addresses do not overlap either endpoint's routes. `10.77.255.1` and `.2` in the example are proposals, not allocated addresses.

Install WireGuard tools and Tailscale from their official repositories if absent. On the **server itself**, generate its WireGuard key with restrictive file permissions. Keep its private key there. On the MikroTik, create the specifically approved `pamofi-management` WireGuard interface and read only its public key. RouterOS retains its private key. Authenticate Tailscale interactively and verify the exact admin account; no auth key or private key belongs in Git or a chat message.

Copy `public-plan.example.json` outside Git, replace every placeholder with observed public values, and run:

```sh
node pamofi-backend/infra/remote-access/plan.mjs /private/public-plan.json /private/pamofi-remote-review
```

The generator creates only review files: the server WireGuard configuration, router commands, a narrow tailnet policy fragment and a route-advertisement command. It validates identifiers and refuses accidental overwrite. It performs no remote operation. In the server config, substitute the local private key only on the server; do not distribute that completed file.

## Activate with narrow access

The concrete change includes one public **UDP WireGuard endpoint** on the selected server, one peer, a `/32` route to the router and the stated owner-only management access. Creating that access requires the owner's action-time confirmation in a browser-driven setup. Do not change the router's current password or overwrite management/Quick Set configuration. Credential entry belongs to the owner when required by the browser's credential handoff rules.

1. Configure the dedicated server WireGuard interface and its single peer. Allow the chosen UDP port in both the host firewall and cloud security rules; do not broaden SSH or web-management ingress. Keep existing host firewall policies, Docker rules and unrelated services intact.
2. On the server, enable the forwarding needed for the Tailscale-to-WireGuard route and retain Tailscale's default subnet SNAT. That makes the router see the server's tunnel address, which is the only source the router peer accepts. Add only the required `tailscale0` → management WireGuard → router `/32` port allowances and established return traffic using the host's existing firewall manager. Verify other traffic to/from that interface is refused. Do not replace the host firewall with a generic script.
3. Apply the reviewed router peer/address/route and correctly ordered input rules in Safe Mode with an independent local recovery path. The generated rules must be placed **before** the existing non-LAN input drop. Deny forwarding from the management tunnel to LAN clients. Existing credentials, DHCP, uplink and wireless stay intact.
4. Advertise only the router `/32` from the server and approve that exact route in the Tailscale admin console. Review the existing tailnet policy before merging the supplied fragment: grants are additive, so an existing allow-all grant can make a new narrow grant ineffective. Preserve unrelated access, remove any unintended broad permission to this router, and test both the owner allow cases and a real non-owner deny case.
5. Connect the owner's second-network device to Tailscale. Windows/macOS/mobile accept subnet routes automatically; a Linux client needs `tailscale set --accept-routes`. Open the dedicated tunnel address, rather than a common `192.168.88.1` address that might overlap the remote network. HTTP WebFig is encrypted over the private tunnels; qualify HTTPS management with a trusted certificate for stronger end-to-end protection. WinBox is an optional permitted management client. The policy does not permit SSH/API unless separately reviewed.

## Verify before claiming it works

Use a genuinely separate connection such as mobile data with local Wi-Fi disabled. Verify recent WireGuard handshakes, Tailscale connectivity, route approval, the permitted router login, denial from a non-owner identity, denial to other LAN addresses, and an external scan showing no public WebFig/WinBox/API listener. Test a router reboot and a server restart, confirm reconnection, and verify the original local management path still works. Record the selected host, public keys, route, identity, exact firewall changes and acceptance timestamps without private credentials.

To revoke, disable the exact approved tailnet route and grant first, then disable the dedicated server/router WireGuard peer/interface and its individually tagged rules. Preserve the existing LAN and all unrelated firewall entries. Delete credentials only after confirming recovery and that the tunnel is no longer required.

References: [MikroTik WireGuard](https://help.mikrotik.com/docs/spaces/ROS/pages/69664792/WireGuard), [architecture support](https://help.mikrotik.com/docs/spaces/ROS/pages/146440194/Feature+support+based+on+architecture), [Tailscale subnet router setup](https://tailscale.com/docs/features/subnet-routers/how-to/setup), [route approval](https://tailscale.com/docs/reference/route-injection), and [Tailscale subnet SNAT](https://tailscale.com/docs/features/site-to-site).
