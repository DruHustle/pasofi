# API and event contracts

Each service owns its `openapi.yaml`. Identity documents session creation/read/logout and recovery; prepaid documents catalogue, simulated orders and access history; assistant documents public help. Network/notification health contracts do not describe all private lab/domain functions.

Private integrations are implemented and tested in their owning services:

- Identity resolves sessions only for a valid scoped token.
- Network presents an authenticated NAS context to prepaid; the RADIUS listener also checks mutual TLS and a pinned certificate.
- Outbox events carry ID, type/version, aggregate/version, occurrence time, correlation ID and a delivery reference. Notification validates the scoped token, deduplicates transactionally and rejects conflicting duplicates.

The web proxy allowlists customer routes. Do not forward internal, RADIUS or provider callback endpoints into the browser API.

Specifications remain incomplete for private and unfinished operational workflows. Extend the owning contract and authorization tests when exposing endpoints. Domain functions are not automatically staff-authorized HTTP APIs.
