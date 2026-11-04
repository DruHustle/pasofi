# Captive welcome handoff

`rlogin.html` is the RouterOS HotSpot redirect page for an unauthenticated
visitor. It directs them to the PamoFi welcome page without passing the
original destination, a device identifier or credentials in the URL. The
manual link provides a fallback if automatic redirection is unavailable.

This page is **not yet installed or physically qualified**. Before installing,
prepare a separate copy of the router's complete existing HotSpot HTML
directory, replace only `rlogin.html` in that copy, and point only the pilot
HotSpot profile to the copy. Retain the default `login.html` and other RouterOS
pages: the PamoFi customer connection flow needs the router's HTTPS `/login`
page to remain reachable. Do not overwrite the shared default directory.

The pilot also needs correctly scoped DNS, a walled garden for the actual
frontend and its dependencies, HTTPS, forwarding and isolation. Test captive
discovery, the welcome page, direct router sign-in, failed login and successful
login on real devices before enabling sales. RouterOS can redirect ordinary
HTTP requests, but cannot transparently redirect arbitrary HTTPS requests
without a certificate error. Do not bypass such errors.
