# Oracle private staging

This Compose stack is a private staging environment, not a production prepaid Wi-Fi service. It publishes no host ports and uses an internal Docker network, publishes no bundle offers, disables simulated payment and lab RADIUS paths, and does not contact payment or SMS providers. It has no public reverse proxy, production identity wiring, staff access, backup/restore, physical router, or live provider integration. Do not connect customers to it.

Use individually generated 32-byte random hexadecimal values for the PostgreSQL bootstrap password, each of the five database-role passwords, and each internal service secret. Store them in a mode-0600 `.env` file outside version control. Set `PAMOFI_RELEASE` to the exact release tag of the five prebuilt `linux/amd64` images. The database role passwords must be distinct. Back up and restore must be designed and tested before storing real data; this stack is not a backup strategy.

Example `.env` variable names: `POSTGRES_PASSWORD`, `IDENTITY_DB_PASSWORD`, `PREPAID_DB_PASSWORD`, `NETWORK_DB_PASSWORD`, `NOTIFICATION_DB_PASSWORD`, `ASSISTANT_DB_PASSWORD`, `INTERNAL_IDENTITY_SECRET`, `INTERNAL_EVENTS_SECRET`, `PAMOFI_RELEASE`. Never put real values in the repository.

Before initializing a new volume, ensure the non-secret `init.sh` is mode 0755, and run a container as UID 70 to verify it can read and execute the bind mount. A restrictive extraction umask can otherwise leave a partially initialized PostgreSQL volume. Start PostgreSQL first and wait for readiness. Run each service's migrations as a separate release step before starting its container. Health checks run inside each container and verify only process/database readiness. The staging database roles currently have migration privileges; production must use separate runtime and migration roles.

## HTTPS without a domain

An interim public endpoint could use a Let's Encrypt certificate for the VM's public IP, if that IP is kept stable and the selected clients and payment providers accept IP-address URLs. These certificates expire after approximately six days, so automatic renewal, reload, and expiration alerting are prerequisites. Let's Encrypt's current Certbot guidance requires a recent client and a reachable validation endpoint; it does not automatically install the IP certificate into the web server. See [Let's Encrypt's Certbot guidance](https://letsencrypt.org/2026/03/11/shorter-certs-certbot.html). No certificate or public endpoint has been configured for this staging stack. A stable, owner-controlled domain is preferable for a lasting captive portal and is still needed wherever a provider requires a hostname.

Do not expose the staging stack merely to obtain a certificate. Public ingress, service authorization, key management, monitoring, backup and restore, router qualification, and payment-provider qualification must be designed and tested first.
