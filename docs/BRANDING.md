# Pasofi naming and compatibility

The product display name is **Pasofi**. Its canonical repository is
`DruHustle/pasofi`, and its production website is
`https://pasofi.mobile.onesa.eu/`.

Current web and mobile screens, launch names, page metadata, captive portal
templates, help, receipts, invoice presentation and transactional message text use
this spelling. The blue/green visual identity is unchanged.

## Infrastructure labels

Use the lowercase value `pasofi` for operational metadata. Pasofi-owned
containers, networks, new managed volumes and first-party production images use
`eu.onesa.product=pasofi`. The Onesa installers use `pasofi` in systemd
descriptions and operational alerts. For an existing independently managed
resource, keep its working identity and record its product association.

Docker cannot update native labels on an existing standalone object. These
declarations take effect when a reviewed release creates an object. Do not
recreate or copy a production database, change image pins, or move a backup
repository solely to apply the label. The external database volume and external
provider networks retain their existing names. Owner-created RADIUS containers
use the same label when next created and keep their original names, private
bindings and owner-verified pins. Shared Onesa infrastructure can host Pasofi
without belonging exclusively to it.

## Compatibility exceptions

The following established identifiers are deliberately retained. They are not
alternative product brands and must not be renamed as a text-only cleanup:

| Identifier | Reason |
| --- | --- |
| `com.onesa.pasofi` | Installed Android/iOS application identity and signing |
| `PasoFiCustomerApi`, `PasoFiStripe`, matching native classes and Info.plist keys | Existing JavaScript/native bridge and signed entitlement contract |
| `X-PasoFi-Native-Customer`, existing `X-PamoFi-*` / `X-Pamofi-*` headers | Deployed transport contract |
| Existing `pamofi.*` storage keys, `__Host-pamofi_*` cookies and `PAMOFI_*` settings | Existing sessions, queued retries, configuration and recovery |
| `PasoFi staff` TOTP issuer | Existing authenticator enrolment and frontend validation contract |
| Stripe response `merchantDisplayName: 'PasoFi'` | Older installed native builds validate this exact wire value. Updated native PaymentSheet presentation shows **Pasofi**. A future wire change requires a versioned rollout. |
| Configured SMS sender identifiers, including the legacy fallback `PasoFi` | Provider provisioning may bind the accepted alpha sender. Message bodies use **Pasofi**; a sender rename needs provider acceptance. |
| Existing RouterOS resource identities, SSIDs and operational service filenames | Management, deployed configuration and recovery may reference them |

New exported invoice filenames start with `Pasofi-`. Native temporary-export
cleanup also recognises the previous `PasoFi-` filenames so an app upgrade does
not leave private cached invoices behind.

Historical migrations, release records, immutable invoice snapshots and existing
router observations preserve their recorded identifiers. Current templates do
not alter stored data or deployed router settings.

## Release scope

A branding release does not enable payments, qualify a site, register a NAS,
change access allowances or establish physical-device acceptance. Backend email
and invoice templates require the matching backend release; native launch names
and PaymentSheet presentation require a new signed native build. Router portal
templates require an independently verified router installation.
