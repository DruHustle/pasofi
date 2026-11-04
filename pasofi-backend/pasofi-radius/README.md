# FreeRADIUS lab

`lab/run-lab.sh` starts a disposable, isolated Docker Compose project containing a real FreeRADIUS 3.2.9 server, two simulated NAS clients, the network service, prepaid-access service and PostgreSQL. It requires Docker, OpenSSL, Python 3 and Node 22+. Run it from any directory:

```sh
./pasofi-radius/lab/run-lab.sh
```

The script builds the two service images, chooses a non-overlapping private Docker subnet, creates one-use TLS keys and disposable database fixtures, runs RADIUS packets, and removes its own containers, networks, images and test data on exit. All RADIUS secrets in the lab are public test values. Do not use the lab configuration or keys on real equipment.

The lab checks an Access-Accept with an authoritative reservation, mutual TLS between FreeRADIUS and the network service, two separately registered NASes with different RADIUS shared secrets, grant retry, refusal at the second site, rejection of another NAS's accounting, 64-bit limits including a zero low word, duplicate accounting, conservative Stop handling and failure when the prepaid authority is unavailable. An additional network-service integration test verifies refusal of missing and wrong client certificates.

This disposable lab uses `APP_ENV=demo`, `NODE_ENV=development` and `INTERNAL_RADIUS_ENABLED=true`; its public test keys and fixtures must never be used for production. The service source also supports the separately guarded production path through `PAMOFI_RADIUS_QUALIFIED`, with the distinct mTLS listener and protected secrets described in the [network service](../services/network-service/README.md). Customer credential issuance, authorized NAS registration, verified disconnect/re-query, conservative reservation reconciliation and service-owned monitoring are implemented and covered by separate tests.

For the selected Oracle/Starlink deployment, use the [production RADIUS package](../infra/radius-production/README.md) and [outbound site-link preparation](../infra/site-link/README.md), not this lab Compose file. Qualification flags remain records of completed acceptance. Physical testing is deferred until software completion: this lab verifies that FreeRADIUS emits a 64-bit limit, not that the actual MikroTik enforces it. No physical HotSpot or private tunnel has been activated.

The network and prepaid services own separate databases. FreeRADIUS does not access the prepaid database. The network API checks a client certificate and pinned fingerprint, resolves the NAS from the source-matched FreeRADIUS client shortname, verifies a short-lived test credential, and calls the prepaid lab authority with a short-lived scoped service JWT. The prepaid service reserves capacity before access is accepted, binds the NAS session to the reservation, and commits accounting before returning an acknowledgement. Stops leave the reservation uncertain pending trustworthy termination and final reconciliation.
