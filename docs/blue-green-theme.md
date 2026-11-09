# Shared blue-green theme

Pasofi and Onesa Mobile use the same blue-green palette while retaining their
own navigation, product behavior and readiness labels. This is visual alignment;
it does not integrate their accounts, payments, APIs or runtime packages.

| Role | Color |
| --- | --- |
| Primary action | Blue `#075CF5` with white text |
| Primary hover | Darker blue `#0647C7` |
| Brand surface and heading | Deep teal `#103C35` |
| Strong green accent | Green `#006F53` |
| Soft accent | Mint `#C7F5B5` with dark teal text |
| Main background | Paper `#F8F9F5` |
| Body text | Ink `#143B34` |
| Secondary text | Muted `#5C716A` |
| Borders | `#DAE3DA`; control borders `#718A78` |
| Light supporting surfaces | Blue `#EAF2FF` or green `#E9F7EF` |

Use blue for ordinary primary actions and deep teal/green for branded surfaces
and supporting accents. Mint actions on dark branded panels are an intentional
contrast variant. Keep warning/error colors and meanings distinct. Do not use
purple or neon lime as unrelated brand accents.

Hero emphasis on a blue surface uses the light green `#E9F7EF`, which keeps
the existing 4.5:1 text-contrast requirement. Soft mint remains a surface
color paired with dark teal text, rather than small text on primary blue.

The palette is repeated within independently buildable packages; there is no
cross-repository runtime import. Typography, spacing, responsive breakpoints,
control dimensions and information architecture remain product-specific.
Both current products retain their existing light-theme behavior.

Changing colors must not change live/demo boundaries, payment capabilities,
authentication, navigation, consent or product-readiness statements. Source
checks and web previews do not establish native device or store qualification.

## Pasofi implementation

Web colors live in `pasofi-frontend/web/src/premium.css`, `home.css` and the
customer/invoice styles. Capacitor colors live in the corresponding independent
`pasofi-frontend/mobile/src/` styles. The customer premium and invoice styles
remain byte-identical across web and Capacitor. Existing legacy variable names
are retained where selectors depend on them; their active values follow this
palette. Native build workflows still build and sync fresh assets before
compilation.
