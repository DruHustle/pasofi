# RouterOS

For the ready-to-load preparation files and WinBox upload, checksum, dry-run,
Safe Mode and rollback steps, see [How to load the router scripts](HOW_TO_LOAD_SCRIPTS.md).
The scripts prepare the devices; physical acceptance and service activation
remain separate work.

For downstream Mercusys MR20 equipment, see [MR20 access-point commissioning](MERCUSYS_MR20.md).
The guide distinguishes native AP-mode wiring from the generic LAN fallback and
keeps captive login, RADIUS and quotas at the inspected MikroTik gateway.

The [first router inspection](site-01/INSPECTION.md) records the actual SMIPS hAP lite, RouterOS 7.18.2, existing interfaces/routing and management posture observed read-only on 2026-11-02. No Quick Set, password, uplink, LAN, wireless, firmware or customer HotSpot changes were made.

The owner prefers direct router access and has no always-on site computer. The [remote-access tools](../infra/remote-access/README.md) therefore evaluate direct WireGuard first: a reachable public IPv4 endpoint (with upstream UDP forwarding when needed) or a reachable global IPv6 endpoint can serve the owner's phone/laptop without a separate VPN server. The observed private upstream network alone does not prove CGNAT. Public uplink and IPv6 reachability remain unverified.

An outbound WireGuard tunnel to a public Linux hub with Tailscale is the fallback when direct reachability is unavailable. A local Tailscale subnet router requires an additional always-on device; Back to Home is not supported on this SMIPS unit. Both generated management plans expose only the router's dedicated `/32` and selected services through the VPN. They do not open public WebFig/WinBox, grant customer-LAN access or enable any live configuration.

The software now supports registered sites, private two-minute credentials, mutual-TLS RADIUS authorization/accounting and a certificate-verified RouterOS disconnect/absence adapter. Those capabilities remain gated until a site-specific HotSpot and private-management configuration are approved and tested on the real router. See the [network service contract](../services/network-service/README.md), [FreeRADIUS lab](../pasofi-radius/README.md) and inspection acceptance list. Existing home management and uplink behavior must remain recoverable throughout activation.

Do not paste a generic router setup or apply public demo credentials to the live unit. Generate the customer network only after selecting the physical guest interface/SSID, private management path, addressing, trusted certificates, registered NAS identity and exact firewall ordering from the inspected state. Verify FastTrack/IPv6 behavior, rate/byte enforcement, one active customer across sites, reboot, delayed accounting and physical disconnection before removing a software qualification gate.

## HotSpot authentication contract

PasoFi's current RADIUS authority accepts `User-Name`, `User-Password` (PAP) and `Acct-Session-Id`. The production FreeRADIUS client also requires `Message-Authenticator`, a source-matched NAS `/32` and that NAS's independent shared secret. RADIUS travels inside the private encrypted site tunnel; FreeRADIUS then uses mutually authenticated TLS to reach the authority. CHAP, EAP and MSCHAP are unsupported and must fail closed.

Prepare a **trusted HTTPS-only paid customer login** for the later hardware test: the selected HotSpot profile must include `https` in `login-by`, its matching `ssl-certificate`, `use-radius=yes` and the exact registered HTTPS `/login` address. Keep customer credentials in the HTTPS POST body. The web and mobile clients either open that registered page for manual entry or, when separately allowed, POST the same username/password fields directly. They do not calculate a CHAP response. RouterOS's default `http-chap,cookie` profile does not match this contract; plaintext `http-pap` is not an acceptable substitute. MAC-based and automatic cookie login must not bypass the qualified paid credential flow.

The owner's optional two-minute welcome is a separate, bounded RouterOS trial.
Follow the [welcome policy and acceptance steps](portal/welcome/README.md) when
adding `trial` to the selected profile. Keep its own time/rate limits and
isolation, and do not create a paid entitlement or treat trial success as paid
RADIUS acceptance. The web-page installer alone does not activate that policy.

During physical acceptance, verify that the real Access-Request contains `User-Password`, `Acct-Session-Id` and a valid `Message-Authenticator`, while retaining only redacted evidence. Check that unsupported authentication and authority outages refuse access. Verify separate known upload-only and download-only transfers, their 64-bit accounting, and total quota enforcement before advertising live usage as physically qualified. Keep all network qualification flags closed until these checks pass. This documentation prepares the contract and changes no router configuration.

MikroTik documents the default CHAP profile, HTTPS login and certificate settings in [HotSpot — Captive portal](https://help.mikrotik.com/docs/spaces/ROS/pages/56459266/HotSpot%2B-%2BCaptive%2Bportal), and distinguishes PAP `User-Password` from CHAP attributes in its [RADIUS reference](https://help.mikrotik.com/docs/spaces/ROS/pages/328097/RADIUS).
