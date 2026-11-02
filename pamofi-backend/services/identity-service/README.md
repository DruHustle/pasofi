# identity-service

Independent build: `npm ci && npm test && npm run build`. Set `DATABASE_URL` to this service’s database before `npm start`. This initial implementation is not production-ready; see `../../docs/BUILD_STATUS.md`.

Apply owned migrations as a separate release step with `DATABASE_URL=... npm run migrate`. The database user must have migration privileges. This local-demo setup does not yet separate runtime and migration roles.

`POST /v1/session` creates a customer session after validating `PUBLIC_ORIGIN`; `GET /v1/session` resolves the opaque cookie. New sessions require a 32-byte cryptographically random, unpadded base64url `Idempotency-Key`. A retry without the cookie returns the original cookie and identity for 24 hours; expired or revoked sessions cannot be resurrected. The retry key is a short-lived credential: protect it, never log it, and clear it after the cookie is confirmed. The database stores only hashes of the retry key and session token.

Configure a distinct, secret, persistent `SESSION_CREATION_SECRET` of at least 32 bytes for each environment; do not reuse the demo value. The server derives the cookie using HMAC so it can reissue it without retaining plaintext. Changing that secret while requests are in flight makes their retries unavailable; already issued cookies continue to work. Coordinate rotation after the 24-hour retry period or implement a versioned key ring before production. Set `APP_ENV=demo` only locally. Production requires an HTTPS origin and rejects the demo secret. Customer recovery and scoped internal session resolution exist, but staff login and MFA are not implemented.
