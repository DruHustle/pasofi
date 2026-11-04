# Hotspot certificate host-copy monitoring

`check.sh` validates the Oracle-hosted public certificate's hostname and warns
at 30 days to expiry. The service uses the existing PamoFi `OnFailure` alert
path, and its timer checks daily. Install the script root-owned and executable
at `/usr/local/sbin/pamofi-hotspot-cert-check` and install the two units under
`/etc/systemd/system` only after reviewing their paths and the alert service.
Enable the timer and run the service once; verify the owner alert channel
separately.

This monitor does **not** renew certificates, install them on a router, or
check what a router serves. Those operations and a separate check of the live
router certificate remain necessary before customer service. Never put the
certificate private key into this repository.

Run `node --test pasofi-backend/infra/hotspot-certificate/check.test.mjs`.
