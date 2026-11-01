#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
for dir in services/*-service; do
  (cd "$dir" && npm ci --no-audit --no-fund && npm run build)
done
docker compose up --build -d
printf '\nBackend catalogue: http://127.0.0.1:18082/v1/bundles\nHelp: http://127.0.0.1:18085/v1/help\n'
