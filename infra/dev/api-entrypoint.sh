#!/usr/bin/env bash
# Dev API boot: wait for postgres, run migrations, then start --watch.
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env.dev}"
if [ ! -f "$ENV_FILE" ]; then
  ENV_FILE=".env"
fi

until (echo > /dev/tcp/postgres/5432) >/dev/null 2>&1; do
  sleep 1
done

bun --env-file="$ENV_FILE" apps/api/src/db/migrate.ts
exec bun --env-file="$ENV_FILE" --watch apps/api/src/server.ts
