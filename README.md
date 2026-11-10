# Pasofi

Pasofi is Onesa's prepaid Wi-Fi platform for customer accounts, vouchers, cash
sales, usage, staff operations and hotspot access. The production website is
[pasofi.mobile.onesa.eu](https://pasofi.mobile.onesa.eu/).

| Component | Source |
| --- | --- |
| Customer and staff web application | `pasofi-frontend/web/` |
| Android and iOS applications | `pasofi-frontend/mobile/` |
| Identity, prepaid access, network, notifications and help services | `pasofi-backend/services/` |
| Oracle deployment, RADIUS, backup and remote-management tooling | `pasofi-backend/infra/` |
| RouterOS commissioning and captive portal templates | `pasofi-backend/pasofi-routeros/` |

See the [backend guide](pasofi-backend/README.md),
[cash launch requirements](pasofi-backend/docs/CASH_HOTSPOT_LAUNCH.md),
[native customer connection](NATIVE_CUSTOMER_CONNECTION.md) and
[Stripe integration](STRIPE_PAYMENTS.md) for implementation and acceptance
requirements. The [branding contract](docs/BRANDING.md) records the display name
and retained technical identifiers.

Readiness must be established separately for every site and payment method.
Source code, a successful build or a passing simulated transaction does not
establish a working customer hotspot. Cash sales require qualified routers,
RADIUS authorization and accounting, voucher issuance/redemption and an observed
customer internet session. Electronic payments remain disabled until their
provider, merchant, network and supported-device acceptance is complete.
