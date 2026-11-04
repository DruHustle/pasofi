# PasoFi welcome connection

These small RouterOS templates use the vivid blue PasoFi theme, a local
stylesheet and inline Wi-Fi artwork. They require no Internet assets before
sign-in. When RouterOS reports an eligible trial, `login.html` automatically
POSTs the standard trial identity to the exact HTTPS hotspot origin. A button
works without JavaScript. Login errors stop automatic retries. Device identity
and paid credentials are never added to external URLs.

`status.html` displays the router's remaining time. Its countdown returns to the
login page after expiry, including when a backgrounded browser resumes. The
router, not JavaScript, must enforce all time/rate limits. After the welcome
period, the normal screen offers PasoFi; technical login is a collapsed
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
