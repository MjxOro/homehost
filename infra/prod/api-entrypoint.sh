#!/usr/bin/env bash
# Prod API boot: migrations are ledger-tracked + advisory-locked, safe every boot.
set -euo pipefail
bun apps/api/dist/db/migrate.js
exec bun apps/api/dist/server.js
