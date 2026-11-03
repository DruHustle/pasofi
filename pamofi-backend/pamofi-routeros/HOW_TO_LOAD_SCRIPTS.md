# Load the PamoFi router scripts with WinBox

These files prepare and inspect the two routers. **They do not enable prepaid
Wi-Fi or complete a sale.** Customer access must stay disabled until the actual
router, captive portal, RADIUS accounting, quota enforcement, recovery and
cash-sale flow have been tested. Site 2 needs its own router public key, tunnel
configuration, RADIUS secret and certificate; never copy Site 1's private keys
or shared secret to it.

## Choose the file for the router

| Router | File | What it does |
| --- | --- | --- |
| **Site 1: Kuwadzana** | [site-01/kuwadzana-prepare.rsc](site-01/kuwadzana-prepare.rsc) | For the previously inspected router only. Verifies its existing tunnel, disabled guest network, RADIUS client, certificate and isolation. If missing and the prerequisites match, it prepares the disabled HTTPS HotSpot and guest-only common torrent-port rules. It does not turn on guest Wi-Fi, DHCP, the HotSpot or the RADIUS client. |
| **Site 2: Lawfield Farm** | [site-02/lawfield-prepare.rsc](site-02/lawfield-prepare.rsc) | First-stage preparation only. Prints non-secret network inventory and creates one disabled WireGuard interface with a new private key kept on that router. It does not configure the server peer, RADIUS, guest network, HotSpot or torrent policy. |

The Kuwadzana file is specific to the currently installed certificate and
router public key. A renewed or replaced certificate requires a reviewed script
update. The combined Kuwadzana script and Lawfield script have **not yet been
dry-run on their respective routers**; the individual Kuwadzana HotSpot and
torrent components were previously imported on Site 1. Don't run the Lawfield
file on the Kuwadzana router.

## Before loading a file

1. Connect to the intended router in WinBox and confirm its identity. The
   owner plans RouterOS 7.25.1 and Starlink at both sites; verify the installed
   version, available HotSpot package and actual uplink at each site.
2. Create a password-protected router backup in **Files → Backup**, save the
   password securely, and download the backup to a separate device. Keep an
   independent way to reconnect. Do not reset the router.
3. Confirm that the proposed script is appropriate for the router's current
   state. The Kuwadzana file expects its existing PamoFi tunnel, disabled
   pilot bridge and radio, gateway, disabled DHCP and RADIUS client, and the
   reviewed certificate. It fails rather than create missing prerequisites.
   The Lawfield file refuses an existing `pamofi-service` interface or a
   WireGuard listen-port collision. Inspect and resolve conflicts; do not
   remove unrelated settings.

## Upload and check

1. In WinBox, open **Files → Upload**. In the macOS file picker press
   **Command + Shift + G**, paste the full path to the appropriate `.rsc`
   file from the repository, press Return and click **Open**.
2. Open **New Terminal**. Run the matching read-only checksum command:

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
   import file-name=kuwadzana-prepare.rsc
   ```

   ```routeros
   import file-name=lawfield-prepare.rsc
   ```

3. Read the final output. On Kuwadzana, the HotSpot, Wi-Fi, DHCP and RADIUS
   client must report disabled, with two torrent-port rules. On Lawfield, the
   service interface must report disabled; record its **public** key and the
   non-secret inventory for the site-specific server plan. Never send a
   private key, password or shared secret in chat.
4. On success, press **Ctrl+X** once to keep the changes and confirm
   `Safe Mode released`. If an error appears while `<SAFE>` remains, press
   **Ctrl+D** to roll back and inspect the error. If the terminal disconnects
   or stops responding, do not retry: reconnect and inspect the router first.
   Safe Mode is not a substitute for the off-router backup.

## What remains before launch

Site 1 still needs guest DHCP/DNS and captive access, a qualified private
RADIUS path, real-device accounting and quota tests, recovery checks, an
approved agent and real stock. Site 2 additionally needs its own inspected
uplink, server peer, certificates and credentials, followed by the same
acceptance tests. The prepared common torrent-port rules reduce some traffic;
other ports, encrypted tunnels and VPNs can evade them, while unrelated apps
using those ports may be affected. See [the policy](../infra/pilot-isolation/TORRENT_POLICY.md).
