# Pasofi welcome connection

These small RouterOS templates use the vivid blue Pasofi theme, a local
stylesheet and inline Wi-Fi artwork. They require no Internet assets before
sign-in. When RouterOS reports an eligible trial, `login.html` automatically
POSTs the standard trial identity to the exact HTTPS hotspot origin. A button
works without JavaScript. Login errors stop automatic retries. Device identity
and paid credentials are never added to external URLs.

`status.html` displays the remaining welcome time reported by RouterOS. When
a timed connection expires, the open status page shows an expiry dialog with
bundle and voucher links. A backgrounded status page shows it on return.
Browsers without modal support still show the expiry message and actions on
the page. The login and logout pages offer the same links. An unauthenticated
HTTP probe, status request or logout request goes to that site's fixed HTTPS
login. RouterOS enforces the trial duration and rate limits.

The installer writes the RouterOS `api.json` template. With a valid HotSpot DNS
name and certificate, RouterOS advertises its HTTPS `/api` endpoint through DHCP.
It reports the active session's remaining time and directs a captive client to
the local login. The phone controls its system captive-portal window. If that
window closes, reopen **Sign in to network** or open the site's local HTTPS
`/login` from a normal browser.

The intended owner-requested policy is 5 minutes per device every 24 hours,
with 1 Mbps upload and 3 Mbps download. Verify each K0/G0 profile uses exactly `trial-uptime-limit=5m` and `trial-uptime-reset=1d` before publishing this copy. RouterOS trial eligibility is based on
MAC address, not a verified person; it is a small welcome allowance, not paid
entitlement or a tamper-proof identity quota. An authenticated account limit would require a server-side trial claim and a separate local guest rollout. It must not create a cash sale
or paid ledger entry. Paid RADIUS accounting needs its own commissioning.

To reproduce the existing trial on G0 and K0, copy [trial-policy.rsc](trial-policy.rsc)
and set `profileName` to the inspected HotSpot profile. G0 and K0 own their trial
profiles. K1 forwards the guest VLAN to K0. Review any shared trial user profiles,
run the import dry run, and apply in Safe Mode. Compare the previous settings and
the readback before saving. The script requires an existing trial-enabled hotspot
and its dedicated trial user profile.

Generate a private installer with:

```sh
node build-install.mjs EXISTING_DIRECTORY NEW_DIRECTORY HTTPS_PROFILE OUTPUT.rsc
node --test welcome.test.mjs
```

### Select the site and verified portal origins

The command above preserves the existing defaults: `Kuwadzana`,
`https://login.pasofi.mobile.onesa.eu` for the router-local HTTPS HotSpot login,
`https://hotspot.pasofi.mobile.onesa.eu` for the hosted captive PasoFi page, and
`https://pasofi.mobile.onesa.eu` for the main PasoFi website. Those defaults are historical
template values, not evidence that either site is ready or that the public app
is reachable before authentication.

For another site or the [dedicated captive customer app](../../../infra/production/HOTSPOT_PORTAL.md),
copy `site-config.example.json` to a local configuration file and replace its
placeholders with the inspected values. Only these three fields are accepted:

| Field | Required value |
| --- | --- |
| `siteLabel` | The actual display name, such as `Lawfield Farm`; 1–80 printable characters. HTML and RouterOS template characters are escaped. |
| `hotspotOrigin` | The verified HTTPS DNS origin served by that router's trusted HotSpot certificate. Its hostname must match the existing HotSpot profile. |
| `appOrigin` | The separately qualified HTTPS customer-app origin. For post-welcome access, use the dedicated gateway portal and its reviewed exact-IP policy. |

Use canonical lower-case DNS origins, with an optional final `/`. Credentials,
explicit ports, path prefixes, queries, fragments, IP literals and matching
HotSpot/app origins are refused. The generator appends the existing `/login`,
`/status`, `/logout` and `/connect` paths itself. It does not verify DNS ownership,
TLS service reachability or installed certificates. No secrets belong in this
configuration file.

```sh
node build-install.mjs EXISTING_DIRECTORY NEW_DIRECTORY HTTPS_PROFILE OUTPUT.rsc \
  /protected/site-welcome.json
```

The generated pages consistently use the selected site, HotSpot origin and
customer-app origin, including trial POSTs, the expiry redirect, voucher links
and successful-login/logout pages. The installer checks the selected HotSpot
profile's actual DNS name before copying files. Source and destination router
directories must be distinct and non-overlapping, without path traversal. The
local output is a new mode-0600 file; an existing file is not overwritten.

The installer copies the complete current portal folder and verifies each write
before switching the supplied profile's HTML directory. Read back the exact
guest HotSpot profile and active directory on each router. The installer
requires a fresh target and an empty HTML override. Preserve the source folder
and restore the profile's original `html-directory` to roll back. Run the import
dry run and use Safe Mode on the router. Retain the site's trial limits,
guest isolation, walled garden and sales controls.

Run the physical check on K1 through K0 and on the confirmed guest path through
G0 with mobile data off. Check `/api` for `captive: false` and decreasing
`seconds-remaining` during the first trial, then `captive: true` at expiry.
Check the visible expiry prompt with the status page open and the local login
with the phone's captive window closed. Open **View bundles** and **Redeem a
voucher**, verify that the dedicated portal and its same-origin API remain
reachable through the scoped walled garden, and confirm ordinary Internet
access stops. Verify repeat-login denial, rate limits and private-network
isolation independently on both sites.
