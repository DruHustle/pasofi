# Disposable local test image. This is not a production database image.
FROM postgres:17.11-alpine3.23@sha256:2ad58d61b036d41f2613302e8c0fee03f6fe51e94d68087327ac45d1cebd4b5e
RUN apk add --no-cache pgbackrest=2.57.0-r0
COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
