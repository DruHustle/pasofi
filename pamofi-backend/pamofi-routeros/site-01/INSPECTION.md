# Site 01 — first MikroTik inspection, 2 November 2026

Read through the user-authorized, already signed-in WebFig session at `http://192.168.88.1/webfig/`. This was a read-only inspection; no router settings, credentials, firmware or traffic rules were changed.

| Item | Observed state |
| --- | --- |
| Board | hAP lite |
| Architecture / CPU | SMIPS, one MIPS 24Kc core, 650 MHz |
| RouterOS | 7.18.2 stable, build 11 March 2025 |
| Memory | 32 MiB total; approximately 8–9 MiB free during inspection |
| Flash | 16 MiB total; 7.8 MiB free |
| Current mode | Home AP; country Zimbabwe |
| Uplink | ether1 active; DHCP on an upstream private /24 network |
| Existing management LAN | 192.168.88.1/24, DHCP enabled, existing wireless clients connected |
| Interfaces | ether1–ether4, default bridge, wlan1, pwr-line1, loopback |
| HotSpot servers | None |
| RADIUS servers | None |
| HTTPS management | www-ssl disabled; no certificate selected |
| Other management services | HTTP, WinBox, SSH, Telnet, FTP and API services listed as enabled; no per-service source restrictions visible |
| Firewall | Default input protection drops traffic not coming from LAN; default WAN forwarding protection present; established/related FastTrack enabled |

## Reconnected-session check

After the owner logged in again on 2 November 2026, the same authorized WebFig session was reachable. Resources still showed hAP lite, SMIPS, RouterOS 7.18.2, 32 MiB total RAM, approximately 8.2–8.3 MiB free and 7.8 MiB free flash. WireGuard still contained zero interfaces. The route list contained the DHCP default route through `192.168.0.1`, connected `192.168.0.0/24` on `ether1`, and connected `192.168.88.0/24` on `bridge`.

The proposed dedicated `10.77.255.0/30` management transit does not overlap those observed local networks, but the owner's remote-client routes and, if used, the hub/tailnet routes must also be inspected before allocating its addresses. No new account, tunnel, firewall rule or router configuration was applied during this recheck.

## Direct remote-access follow-up

The owner prefers a direct connection without a separate VPN server. Native WireGuard can provide that when the router is reachable on public IPv4 (with an upstream UDP forward where required), or on global IPv6 from a client with working IPv6. The observed private `192.168.0.0/24` uplink does **not** establish CGNAT. The upstream public address, any ISP CGNAT, global IPv6 allocation/routing, upstream administrative access and external UDP reachability are still unknown. None may be inferred from the local WebFig login.

The [remote-management tools](../../infra/remote-access/README.md) now prepare direct and hub-fallback plans and assess explicitly supplied observations. The SMIPS hAP lite cannot use Back to Home; a local Tailscale subnet router would require the additional always-on site device the owner does not have. The owner-only management tunnel remains separate from PamoFi's backend/RADIUS hosting and service access requirements.

The subsequent browser check could not reach the originating connected-browser context. This is a browser connection limitation, not evidence that the router rejected authentication or that its configuration changed. The last verified device state is the read-only inspection above. No direct/hub handshake, remote-network login, IPv6 reachability, reboot recovery or live firewall denial has yet been verified. Resume the device inspection in the connected browser on the router's LAN before selecting an endpoint and applying an exact recoverable plan.

## Later authenticated browser inspection

The owner subsequently restored the originating browser connection. The authenticated WebFig tab was reachable, so the earlier browser-origin blocker is no longer current. Read-only tables showed `192.168.0.219/24` on `ether1`, a DHCP default route through `192.168.0.1`, and the existing `192.168.88.1/24` management bridge. IPv6 showed only loopback/link-local addresses, no global address or default route, and no DHCPv6 client. IP Cloud displayed an external IPv4 address; that is not evidence of inbound reachability and its value is deliberately not recorded here.

WireGuard, Hotspot and RADIUS tables displayed no entries, consistent with the earlier inspection. The terminal reported that the console was not responding. Resources showed 100% CPU at multiple displayed uptimes, with about 10.8–11.1 MiB free RAM. The profiler returned no process rows and was stopped. Some pages were slow to populate. These are diagnostic observations, not a determined cause or a capacity test. No console/router restart, credential, firewall, route, package or customer-network change was applied.

The owner then confirmed the production topology will place a Starlink router before the MikroTik, with the backend on Oracle and frontend on Vercel, and explicitly deferred physical testing until software completion. The production site design therefore uses an outbound MikroTik-to-Oracle control tunnel; it does not require incoming port forwarding on Starlink. Resume hardware work by checking management responsiveness and a recoverable local connection, then qualify the exact prepared site configuration. The observation of a local upstream private router must not be misrepresented as a test of the eventual Starlink installation.

## Consequences for PamoFi

On 3 November, the reconnected WebFig terminal eventually responded to a read-only resource query. One sample showed 100% CPU and 9.9 MiB free memory; a separate earlier WebFig sample showed 11% CPU, so this is variable load rather than a measured cause. A targeted read of the `admin` account's CLI inactivity policy returned `none`: its inactivity lock/logout is already disabled. This setting applies to CLI sessions and does not establish WebFig session behavior or repair an unresponsive router. No inactivity or other router setting was changed.

This device is suitable for a measured pilot subject to actual capacity and firmware qualification; the inspection does not establish a supported paying-customer count. Its small RAM/flash budget makes a load test and free-space check necessary before changing packages or increasing concurrent sessions. The backend, databases, RADIUS authority and payment/SMS workers stay on the server.

Preserve the existing management LAN and wireless connection. Prepare a separate customer interface/bridge and subnet, explicitly isolated from management and upstream private networks. Do not run the Quick Set replacement configuration over the existing live LAN. Provision a certificate and a restricted service account for HTTPS management over the private management tunnel. The PamoFi worker uses only authenticated server-side HTTPS REST calls; no management password is placed in the customer app.

Exclude all customer traffic from FastTrack before testing quotas: MikroTik documents that FastTrack bypasses accounting, queues and the HotSpot universal client. IPv6 must not provide an unmetered bypass around the IPv4 HotSpot. Only permit the chosen portal and verified provider endpoints in the walled garden; do not create broad wildcard internet access.

The exact public portal hostname, private server/tunnel addresses, device certificate, service/RADIUS credentials, and customer interface/subnet are deployment inputs. They have not been invented or enabled. A first-site configuration can only be applied after those values and a recoverable management path are concrete. Creating a router management account or enabling new access is a separate consequential change from this read-only inspection.

Before a RouterOS upgrade, export configuration without secrets, make a separately protected recovery backup, check flash capacity and review the target release for this architecture. Since RouterOS7.20, SMIPS HotSpot is a separate package; an upgrade must retain the matching HotSpot capability. Do not assume the latest package set is interchangeable with the inspected7.18.2 device.

## Hardware acceptance sequence

1. Record current bridge members, IP routes, DHCP/DNS, device-mode and package support, time synchronization, firewall rule order and a tested local recovery connection.
2. Create the isolated pilot customer network, management tunnel/certificate, per-NAS RADIUS identity and server-side registry entry with the same site UUID as sales administration.
3. Test one synthetic customer: short-lived credentials, successful RADIUS Start, 64-bit upload plus download accounting, byte limit, session timeout and rate enforcement.
4. Verify server outage fails closed; duplicate and reordered accounting does not double-charge; credential replay cannot create a second session; explicit disconnect requires actual NAS absence plus final Stop before reuse.
5. Reboot the NAS with an active synthetic grant and verify uncertain reservations remain blocked until evidenced operator resolution. Repeat across the second physical site before claiming cross-site acceptance.
6. Run a controlled concurrent-client load test, observe memory/CPU/latency and verify client isolation, management isolation, IPv6 controls, FastTrack exclusion and recovery. Record measured results and approved limits.

References: [RouterOS REST API](https://help.mikrotik.com/docs/spaces/ROS/pages/47579162/REST+API), [FastTrack behavior](https://help.mikrotik.com/docs/spaces/ROS/pages/130220087/Connection+tracking), and [MikroTik7.20 release notes](https://forum.mikrotik.com/t/v7-20-stable-is-released/265196).
