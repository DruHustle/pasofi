# Pasofi welcome connection

These small RouterOS templates use the vivid blue Pasofi theme, a local
stylesheet and inline Wi-Fi artwork. They require no Internet assets before
sign-in. When RouterOS reports an eligible trial, `login.html` automatically
POSTs the standard trial identity to the exact HTTPS hotspot origin. A button
works without JavaScript. Login errors stop automatic retries. Device identity
and paid credentials are never added to external URLs.

`status.html` displays the router's remaining time. Its countdown returns to the
login page after expiry, including when a backgrounded browser resumes. The
router, not JavaScript, must enforce all time/rate limits. After the welcome
period, the normal screen offers Pasofi; technical login is a collapsed
fallback. `alogin.html` uses a fixed status destination, avoiding arbitrary
incoming redirect destinations. The same styling covers logout.

The intended owner-requested policy is 2 minutes per device every 24 hours,
with 1 Mbps upload and 3 Mbps download. RouterOS trial eligibility is based on
MAC address, not a verified person; it is a small welcome allowance, not paid
entitlement or a tamper-proof identity quota. It must not create a cash sale
or paid ledger entry. Paid RADIUS accounting needs its own commissioning.

Generate a private installer with:

```sh
node build-install.mjs EXISTING_DIRECTORY NEW_DIRECTORY HTTPS_PROFILE OUTPUT.rsc
node --test welcome.test.mjs
```

### Select the site and verified portal origins

The command above preserves the existing defaults: `Kuwadzana`,
`https://hotspot.pasofi.onesa.eu` for the router's HTTPS HotSpot and
`https://pasofi.onesa.eu` for the customer app. Those defaults are historical
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

The installer copies the complete current portal folder, verifies each write,
then changes only the supplied profile's HTML directory. It refuses an existing
target. Preserve the original folder for rollback. It does not enable trial,
forwarding, a walled garden, or sales. Deploy the matching bounded trial profile
and authenticated-only public forwarding separately, retaining private-network,
IPv6 and client isolation. Run the import dry run and use Safe Mode on the router.

Before release, physically verify HTTPS/captive discovery, automatic trial login,
actual Internet transfers, router time expiry, repeat-login denial, rate limits,
private-network isolation, and the customer app after expiry. The customer app
must be reachable through a scoped walled garden even after the welcome expires;
do not interpret the link existing on the page as evidence that this works.
Native iOS captive windows can close automatically when Internet becomes
available; the countdown is always available at the hotspot's HTTPS `/status`.
