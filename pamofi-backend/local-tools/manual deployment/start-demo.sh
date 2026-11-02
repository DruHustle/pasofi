#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
for dir in services/*-service; do
  (cd "$dir" && npm ci --no-audit --no-fund && npm run build)
done
docker compose build
docker compose up -d --wait postgres
for service in identity prepaid-access network notification assistant; do
  docker compose run --rm --no-deps "$service" npm run migrate
done
docker compose up -d --wait --wait-timeout 90
printf '\nBackend catalogue: http://127.0.0.1:18082/v1/bundles\nHelp: http://127.0.0.1:18085/v1/help\n'
