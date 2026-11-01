# identity-service

Independent build: `npm ci && npm test && npm run build`. Set `DATABASE_URL` to this service’s database before `npm start`. This initial implementation is not production-ready; see `../../docs/BUILD_STATUS.md`.

Apply owned migrations as a separate release step with `DATABASE_URL=... npm run migrate`. The database user must have migration privileges. This local-demo setup does not yet separate runtime and migration roles.

`POST /v1/session` creates a customer session after validating `PUBLIC_ORIGIN`; `GET /v1/session` resolves the opaque cookie. Set `APP_ENV=demo` only locally. Production requires an HTTPS origin. Cookie-bearing retries reuse the identity; a lost first response without its cookie is not yet recoverable. There is no staff login, recovery or internal authorization yet.
