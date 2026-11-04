# Captive welcome handoff

`rlogin.html` is the RouterOS HotSpot redirect page for an unauthenticated
visitor. It directs them to the PasoFi welcome page without passing the
original destination, a device identifier or credentials in the URL. The
manual link provides a fallback if automatic redirection is unavailable.

This page is **not yet installed or physically qualified**. Before installing,
prepare a separate copy of the router's complete existing HotSpot HTML
directory, replace only `rlogin.html` in that copy, and point only the pilot
HotSpot profile to the copy. Retain the default `login.html` and other RouterOS
pages: the PasoFi customer connection flow needs the router's HTTPS `/login`
page to remain reachable. Do not overwrite the shared default directory.

The pilot also needs correctly scoped DNS, a walled garden for the actual
frontend and its dependencies, HTTPS, forwarding and isolation. Test captive
discovery, the welcome page, direct router sign-in, failed login and successful
login on real devices before enabling sales. RouterOS can redirect ordinary
HTTP requests, but cannot transparently redirect arbitrary HTTPS requests
without a certificate error. Do not bypass such errors.

## Isolated Kuwadzana pilot

`pilot-login.html` is a self-contained offline login page for the current
Kuwadzana test. `site-01/pasofi-kuwadzana-branded-login.rsc` copies the
router's existing complete HotSpot directory, replaces only the copy's login
page and points the pilot profile to the copy. It checks the router identity,
certificate, HTTPS and isolation before changing the profile. It does not
activate guest forwarding, change sales, or qualify authentication. The files
in the copied directory may persist after Safe Mode rollback; the original
folder remains untouched. If a previous attempt leaves the copy behind, inspect
it before retrying. Files must be saved to flash when the router has a flash
disk.

With the isolated pilot already running in the existing Safe Mode terminal,
upload the `.rsc`, run its verbose dry run, then import it. Leave Safe Mode
open and reconnect a spare device to check automatic discovery, the PasoFi
page and certificate. A physical authentication and accounting test is still
required; do not collect a cash payment for this isolated pilot.
