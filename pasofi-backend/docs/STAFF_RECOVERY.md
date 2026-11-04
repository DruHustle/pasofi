# Staff recovery and delivery qualification

Customer recovery uses a different account reference and key. It cannot reset a staff password or authenticator. Staff password recovery remains disabled until an operator has selected and qualified a transactional SMTP provider, verified a sender and receiver mailbox, provisioned protected credentials, and installed a network path restricted to that provider. The code does not treat provider acceptance as proof an email reached the mailbox.

When enabled, a staff member requests a code using their email. The endpoint responds identically before looking up the account, rate-limits the requesting IP, and applies a persistent two-minute per-account delivery throttle. A bounded asynchronous queue avoids returning account-specific delivery results. Messages are not durably queued: if the process exits or the provider fails, the generic response remains unchanged and the person can request another code after the throttle period. Monitor sanitized delivery failures; never log an address, password, code or SMTP credential.

The code contains 256 bits of randomness, is stored only as a hash, expires after 15 minutes, and is bound to the current staff record version. Confirmation consumes it atomically, changes the password, increments the version, revokes staff sessions and pending challenges, and appends a `password_reset` audit event. Existing MFA remains in place and is required after password reset. Invalid, expired, superseded and used codes produce the same invalid-recovery response. A reset request by itself neither changes the password nor locks the account.

The optional `infra/production/staff-reset-mail.compose.yaml` is **not part of the running stack**. It requires explicit enablement and qualification settings, a hostname, port 465 or 587, account username, verified sender, a mode-restricted `staff_reset_smtp_password` secret file, and a pre-existing egress network restricted to the approved SMTP destination. TLS certificate and hostname validation cannot be disabled; the provider must also support the SMTP REQUIRETLS extension so it can be requested for downstream delivery. Before using it, qualify provider TLS, credentials, sender ownership, actual delivery to a controlled mailbox, invalid-address behavior, timeouts, abuse monitoring, recovery, and firewall enforcement. Never place credentials in Git, command-line arguments, frontend variables or logs. Changes to production network isolation require independent review. Back up new secrets using the existing encrypted configuration recovery procedure.

For a lost authenticator, another approved MFA-authenticated administrator must independently verify the person's identity before using the audited authenticator-recovery action. It revokes the target's sessions and roles and returns them to pending. They need their existing password, a new authenticator and an administrator's reapproval. An administrator cannot reset their own MFA. Maintain at least two independently authenticated administrators; when none is available, recovery is blocked pending a separately reviewed owner-operated procedure. Never use SQL edits or bootstrap as an MFA bypass.

Security references: [OWASP Forgot Password guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html) and [Nodemailer SMTP transport](https://nodemailer.com/smtp). These references do not establish provider or production qualification.

## Resend qualification, 2026-11-03

At this historical observation, the account listed `mail.onesa.eu` as a verified sending domain. A read-only TLS SMTP capability probe to `smtp.resend.com:465` did not advertise the `REQUIRETLS` extension. The current transport therefore could not qualify this provider and remained disabled. Resend documents a domain-level enforced TLS policy, but that policy was not independently qualified for this service. This source update does not repeat the probe or resolve that blocker. Do not weaken the existing REQUIRETLS requirement merely to make a test pass. No new provider key was created and no recovery email was sent.

## Shared root-domain sender candidate — 2026-11-04

The selected visible sender is `notifications-pasofi@onesa.eu`, using the single
shared `onesa.eu` sending domain. Root-domain verification in Resend does not prove
SMTP extension support, recipient delivery or this service's recovery qualification.
Both enablement and qualification flags remain `false` in the examples.

The existing production overlay maps the following inputs into the identity service:

| Production Compose input | Identity-service variable | Selected example |
| --- | --- | --- |
| `PAMOFI_STAFF_RESET_ENABLED` | `STAFF_RESET_DELIVERY_ENABLED` | `false` |
| `PAMOFI_STAFF_RESET_QUALIFIED` | `STAFF_RESET_DELIVERY_QUALIFIED` | `false` |
| `PAMOFI_STAFF_RESET_SMTP_HOST` | `STAFF_RESET_SMTP_HOST` | `smtp.resend.com` |
| `PAMOFI_STAFF_RESET_SMTP_PORT` | `STAFF_RESET_SMTP_PORT` | `465` |
| `PAMOFI_STAFF_RESET_SMTP_USER` | `STAFF_RESET_SMTP_USER` | `resend` |
| `PAMOFI_STAFF_RESET_EMAIL_FROM` | `STAFF_RESET_EMAIL_FROM` | `notifications-pasofi@onesa.eu` |

The sender must be a bare address; this transport does not accept a display name
in that field. Resend's documented SMTP password is an API key. Keep an independently
approved key authorized for the root domain in the existing protected
`staff_reset_smtp_password` file, loaded through `STAFF_RESET_SMTP_PASSWORD_FILE`.
The source examples contain no credential, and no sender or credential is issued
automatically. Existing explicitly configured runtime values remain unchanged.

The candidate [production inputs](../infra/production/staff-reset-mail.env.example)
and [local service example](../services/identity-service/.env.example) describe
the existing transport only. Preserve certificate validation, encrypted SMTP,
the message's REQUIRETLS request and the restricted egress boundary. Before any
sender or credential cutover, reconcile in-flight staff reset attempts and their
current tokens without replaying them or resetting the account throttle. The
existing queue is bounded and non-durable; an example change does not migrate it.

Resend [SMTP settings](https://resend.com/docs/send-with-smtp) document the connection
parameters. They do not establish the REQUIRETLS or mailbox acceptance required
above. Keep delivery disabled until those existing requirements are independently
qualified; no alternate provider or policy-bypassing transport is added here.
