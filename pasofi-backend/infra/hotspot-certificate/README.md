# Hotspot certificate host-copy monitoring

`check.sh` validates the Oracle host copies of the router-local HotSpot login
certificates (`login.pasofi.mobile.onesa.eu`, one per router under
`acme/router-login/<site>/`) and warns at 30 days to expiry. The service uses the existing Pasofi `OnFailure` alert
path, and its timer checks daily. Install the script root-owned and executable
at `/usr/local/sbin/pamofi-hotspot-cert-check` and install the two units under
`/etc/systemd/system` only after reviewing their paths and the alert service.
Enable the timer and run the service once; verify the owner alert channel
separately.

Each router generates its own key and certificate request (the key never leaves
the router). `router-login-sign.sh <site>` re-signs the saved request with
Let's Encrypt on Oracle (HTTP-01 through the DNS-only record); import the new
chain on that router as a certificate only, since the key is already there.

This monitor does **not** renew certificates, install them on a router, or
check what a router serves. Those operations and a separate check of the live
router certificate remain necessary before customer service. Never put the
certificate private key into this repository.

Run `node --test pasofi-backend/infra/hotspot-certificate/check.test.mjs`.
