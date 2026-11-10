# Load the Pasofi router scripts with WinBox

These files prepare and inspect the two routers. **They do not enable prepaid
Wi-Fi or complete a sale.** Customer access must stay disabled until the actual
router, captive portal, RADIUS accounting, quota enforcement, recovery and
cash-sale flow have been tested. Site 2 needs its own router public key, tunnel
configuration, RADIUS secret and certificate; never copy Site 1's private keys
or shared secret to it.

## Choose the file for the router

| Router | File | What it does |
| --- | --- | --- |
| **Site 1: Kuwadzana** | [site-01/pasofi-kuwadzana-check.rsc](site-01/pasofi-kuwadzana-check.rsc) | Identifies the inspected router and reports the isolated pilot's status without changing settings or printing credentials. Use this short check first following the interrupted import. |
| **Site 1: Kuwadzana** | [site-01/pasofi-kuwadzana-pilot.rsc](site-01/pasofi-kuwadzana-pilot.rsc) | Prepares a temporary isolated test of DHCP, local HotSpot login and the private RADIUS client. It blocks guest forwarding in IPv4 and IPv6. It has not been run or syntax-checked on the router; it is not a working commercial service. |
| **Site 1: Kuwadzana** | [site-01/kuwadzana-prepare.rsc](site-01/kuwadzana-prepare.rsc) | For the previously inspected router only. Verifies its existing tunnel, disabled guest network, RADIUS client, certificate and isolation. If missing and the prerequisites match, it prepares the disabled HTTPS HotSpot and guest-only common torrent-port rules. It does not turn on guest Wi-Fi, DHCP, the HotSpot or the RADIUS client. |
| **Site 2: Lawfield Farm** | [site-02/lawfield-prepare.rsc](site-02/lawfield-prepare.rsc) | First-stage preparation only. Prints non-secret network inventory and creates one disabled WireGuard interface with a new private key kept on that router. It does not configure the server peer, RADIUS, guest network, HotSpot or torrent policy. |

The [captive welcome handoff](portal/README.md) is prepared separately and has
not yet been installed or tested on either router.

The original isolated pilot omitted TCP port `64874`, which RouterOS uses for
unauthenticated HTTP captive detection. The corrected pilot includes it. If
that original pilot is still active in the same Safe Mode session, the small
[guarded correction](site-01/pasofi-kuwadzana-captive-fix.rsc) updates only
its scoped login rule after verifying the router, empty walled garden and
IPv4/IPv6 forwarding drops. The correction has not yet been syntax-checked or
run on the router. A configured walled-garden entry can allow the local proxy
to reach destinations through the router, so do not add such entries during
this isolated test. The correction does not fix certificates or install the
Pasofi welcome page. See MikroTik's [HotSpot customization documentation](https://help.mikrotik.com/docs/spaces/ROS/pages/87162881/Hotspot+customisation).

The temporary pilot was subsequently rolled back: inspection showed only the
earlier inactive isolation rules, and the short check again reported that the
pilot bridge, Wi-Fi, DHCP, HotSpot and RADIUS client were disabled. Do not run
the incremental captive-detection correction against this state. The prepared
[Pasofi hostname pilot](site-01/pasofi-kuwadzana-pilot-v2.rsc) requires the
reviewed transition certificate and private key to be imported on the router
first. On the owner's Mac, `python3 pasofi-backend/pasofi-routeros/site-01/prepare-pasofi-certificate.py`
creates a password-encrypted bundle in a private temporary directory using the
existing Oracle SSH connection. The password is entered privately and sent to
OpenSSL over standard input; the helper verifies the certificate fingerprint,
hostname, validity and chain. Import the bundle in WinBox with that password,
verify the certificate and private-key counts, then remove its temporary router
and Mac copies. The helper is pinned to the reviewed certificate; review and
update the fingerprint when the certificate is renewed. The pilot script has
not been syntax-checked or run on the router, and service remains disabled.

During the first live pilot, RouterOS reported the HotSpot as invalid because
`/system/device-mode` was set to home with `hotspot: no`, even though the
HotSpot entry was not administratively disabled. Pilot scripts now fail early
when the device-mode feature is disabled. A per-feature update of `hotspot`
requires physical confirmation and reboots the device; it should be performed
after rolling back the temporary pilot. RouterOS Safe Mode does not replace the
independent backup. See MikroTik's [device-mode documentation](https://manual.mikrotik.com/docs/system-information-and-utilities/device-mode/).

The owner ran the short Kuwadzana check on 4 November. It identified the
router, reported 8,007,680 bytes of free memory, an enabled tunnel, one each
of the gateway, disabled DHCP, HotSpot and RADIUS entries, four isolation
rules per IP family, enabled router DNS and the `PasoFi Pilot` SSID. Those
counts do not prove rule order, authentication or usage enforcement.

For the isolated pilot file, keep an independent management connection and
the off-router backup available. Upload it, run
`import file-name=pasofi-kuwadzana-pilot.rsc verbose=yes dry-run`, then enter
Safe Mode with Ctrl+X and run `import file-name=pasofi-kuwadzana-pilot.rsc`.
Keep the same Safe Mode session open while testing a spare device. The script
enables an open pilot SSID, DHCP, local HTTPS HotSpot and the existing RADIUS
client; it installs new IPv4 and IPv6 guest forwarding drops ahead of
FastTrack. It does not open guest internet, publish vouchers, or enable cash
sales; pilot DNS queries can still be resolved through the router. The HotSpot
still uses the previously installed `pamofi` certificate and
hostname; replacing them requires installing the transition certificate and
requalifying the client flow. The Pasofi welcome handoff is not installed.
Press Ctrl+D in the same Safe Mode terminal after the test to roll it back. On
error, press Ctrl+D; if the terminal disconnects or stops responding, do not
retry before inspecting the router. A dry run validates syntax only, and the
test itself does not prove metering or access enforcement.

The Kuwadzana file is specific to the currently installed certificate and
router public key. A renewed or replaced certificate requires a reviewed script
update. On 4 November, the Kuwadzana router restarted during an attempted
checksum, dry-run and import sequence. The outcome of that attempt is unknown;
**do not rerun the combined script until the router's state and stability have
been inspected**. Its individual HotSpot and torrent components were previously
imported on Site 1. The Lawfield script has not yet been dry-run on its router.
Don't run the Lawfield file on the Kuwadzana router.

After that restart, a read-only WebFig inspection found the Pasofi WireGuard
interface running; the pilot bridge, radio, DHCP server, HotSpot and RADIUS
client were disabled. The two common-port torrent rules and four IPv4 pilot
drop rules were present but inactive while the pilot bridge was disabled. The
router log reported a previous kernel failure and an out-of-memory condition;
the exact trigger and the interrupted import's outcome remain unknown. The
hAP lite reported 32 MiB total memory and 7.8 MiB free during inspection. Do
not use a successful idle CPU reading as proof that it can reliably serve
customers; investigate stability and qualify the device under expected load.

On 4 November a temporary DHCP-only pilot was run in Safe Mode. A spare device
associated with `PamoFi Pilot` and received a bound `10.77.10.10` lease.
The disabled radio was subsequently renamed `PasoFi Pilot`; it remains off.
IPv4 pilot forwarding drops recorded traffic. The temporary DHCP rules were
undone afterward; the bridge, radio and pilot DHCP server were confirmed
disabled, and Safe Mode was released. This check did not exercise DNS, captive
login, RADIUS, quota enforcement, payment or end-to-end internet isolation.

For the current bench setup, the owner reported connecting Lawfield's
`ether1` to a Kuwadzana LAN port; verify the port labels before changing
anything. This is a temporary upstream path, not proof that Lawfield's
Starlink connection works. If Lawfield's WAN and LAN both use
`192.168.88.0/24`, their routes overlap and need a site-specific correction
before the tunnel can be qualified. The Lawfield file reports routes and pools
but does not change or repair them.

## Before loading a file

1. Connect to the intended router in WinBox and confirm its identity. The
   owner plans RouterOS 7.25.1 and Starlink at both sites; verify the installed
   version, available HotSpot package and actual uplink at each site.
2. Create a password-protected router backup in **Files → Backup**, save the
   password securely, and download the backup to a separate device. Keep an
   independent way to reconnect. Do not reset the router.
3. Confirm that the proposed script is appropriate for the router's current
   state. The Kuwadzana file expects its existing Pasofi tunnel, disabled
   pilot bridge and radio, gateway, disabled DHCP and RADIUS client, and the
   reviewed certificate. It fails rather than create missing prerequisites.
   The Lawfield file refuses either an existing `pamofi-service` or `pasofi-service` interface, or a
   WireGuard listen-port collision. Inspect and resolve conflicts; do not
   remove unrelated settings.

## Upload and check

1. In WinBox, open **Files → Upload**. In the macOS file picker press
   **Command + Shift + G**, paste the full path to the appropriate `.rsc`
   file from the repository, press Return and click **Open**.
2. Open **New Terminal**. Run the matching read-only checksum command:

   For the short Kuwadzana check:

   ```routeros
   :put [:convert [/file get "pasofi-kuwadzana-check.rsc" contents] transform=sha512 to=hex]
   ```

   ```routeros
   :put [:convert [/file get "kuwadzana-prepare.rsc" contents] transform=sha512 to=hex]
   ```

   or:

   ```routeros
   :put [:convert [/file get "lawfield-prepare.rsc" contents] transform=sha512 to=hex]
   ```

   Compare it with the checksum of the local file, calculated on the Mac with
   `shasum -a 512` and the full local path. Stop if the values differ. Check
   the current repository copy rather than an old download or temporary file.
3. Check syntax, using the matching filename:

   ```routeros
   import file-name=pasofi-kuwadzana-check.rsc verbose=yes dry-run
   ```

   ```routeros
   import file-name=kuwadzana-prepare.rsc verbose=yes dry-run
   ```

   ```routeros
   import file-name=lawfield-prepare.rsc verbose=yes dry-run
   ```

   RouterOS should report `No syntax errors found in the import file`. A dry
   run checks syntax; it does **not** prove the script's runtime checks will
   pass or that customer access works.

## Apply with rollback protection

1. In the same terminal press **Ctrl+X** and wait for `<SAFE>` in the prompt.
2. Run **only the matching command**, without `dry-run`:

   ```routeros
   import file-name=pasofi-kuwadzana-check.rsc
   ```

   ```routeros
   import file-name=kuwadzana-prepare.rsc
   ```

   ```routeros
   import file-name=lawfield-prepare.rsc
   ```

3. Read the final output. The short check changes nothing and reports the
   disabled pilot, tunnel, DHCP, HotSpot, RADIUS and isolation-rule counts;
   it does not enable or validate service. On Kuwadzana, the HotSpot, Wi-Fi, DHCP and RADIUS
   client must report disabled, with two torrent-port rules. On Lawfield, the
   service interface must report disabled; record its **public** key and the
   non-secret inventory for the site-specific server plan. Never send a
   private key, password or shared secret in chat.
4. On success, press **Ctrl+X** once to keep the changes and confirm
   `Safe Mode released`. If an error appears while `<SAFE>` remains, press
   **Ctrl+D** to roll back and inspect the error. If the terminal disconnects
   or stops responding, do not retry: reconnect and inspect the router first.
   Safe Mode is not a substitute for the off-router backup.

   After a restart or lost session, check the existing configuration and the
   router's health before deciding whether anything needs to be reapplied.
   A disconnected Safe Mode session normally rolls back tentative settings,
   but the result must be inspected; do not assume every operation was undone.

## What remains before launch

Site 1 still needs guest DHCP/DNS and captive access, a qualified private
RADIUS path, real-device accounting and quota tests, recovery checks, an
approved agent and real stock. Site 2 additionally needs its own inspected
uplink, server peer, certificates and credentials, followed by the same
acceptance tests. The prepared common torrent-port rules reduce some traffic;
other ports, encrypted tunnels and VPNs can evade them, while unrelated apps
using those ports may be affected. See [the policy](../infra/pilot-isolation/TORRENT_POLICY.md).
