# Pasofi frontends

The web and mobile applications are independent projects with separate dependencies, source and builds:

- [`web`](./web) contains the customer, agent, support and administrator web workspaces, same-origin API boundary and explicit demo fallback.
- [`mobile`](./mobile) contains the iPhone/Android Capacitor projects, useful offline preview and optional customer client for a qualified HTTPS gateway.

Install, test and build inside the appropriate folder. Customer behavior is maintained independently in each frontend; there are no imports from sibling builds or backend implementation packages. The primary purchase journey is agent-confirmed cash, a private paired receipt, explicit voucher redemption, then automatically updated data allowance. Both builds use a consistent whole-account usage snapshot, preserve last-confirmed data when offline, and stop private polling on a session change. Web customer/staff journeys have actual isolated API acceptance coverage. Mobile has offline and configured HTTPS mock coverage plus separate native CI artifacts.

The backend deliberately keeps `mobileCookies: false` until native cookie/CORS/origin handling is qualified. Source builds, simulations and unsigned native artifacts do not establish live payments, SMS, physical hotspot access, signed distribution or a deployed public service. See [current capability and verification status](../pasofi-backend/docs/BUILD_STATUS.md) and each application's README for exact setup and boundaries.
