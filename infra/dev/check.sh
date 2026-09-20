#!/usr/bin/env bash
# Read-only readiness probe for the local dev loop. Never mutates anything.
# Usage: bash infra/dev/check.sh  (or: bun run dev:check)
# FAIL lines (MISS) exit nonzero; WARN lines are info only.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env.dev"

fail=0
ok() { printf 'ok   %s\n' "$1"; }
miss() { printf 'MISS %s\n' "$1"; fail=1; }
warn() { printf 'WARN %s\n' "$1"; }

# Print the last KEY= value from .env.dev, unquoted. Prints empty when absent.
env_val() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 \
    | sed -e "s/^$1=//" -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" | tr -d '\r'
}

# --- toolchain ---
if command -v bun >/dev/null 2>&1; then
  bv=$(bun --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
  major=${bv%%.*}
  minor=${bv#*.}
  if [ -n "$bv" ] && { [ "$major" -gt 1 ] || { [ "$major" -eq 1 ] && [ "${minor%%.*}" -ge 4 ]; }; }; then
    ok "bun $bv (>=1.4)"
  else
    miss "bun ${bv:-unknown} (<1.4, upgrade: https://bun.sh)"
  fi
else
  miss "bun not installed (https://bun.sh)"
fi

if command -v docker >/dev/null 2>&1; then
  ok "docker $(docker --version 2>/dev/null | head -1)"
  if docker compose version >/dev/null 2>&1; then
    ok "docker compose $(docker compose version --short 2>/dev/null | head -1)"
  else
    miss "docker compose plugin missing (docker compose version failed)"
  fi
else
  miss "docker not installed"
fi

if docker network inspect homehost-edge_default >/dev/null 2>&1; then
  ok "network homehost-edge_default exists"
else
  miss "network homehost-edge_default missing (docker network create homehost-edge_default)"
fi

# --- ports (dev stack: api 3001, web 5174, postgres 55433) ---
for port in 3001 5174 55433; do
  if ss -tln 2>/dev/null | grep -q ":${port} "; then
    miss "port ${port} already bound (stop the clash or the dev stack will fail)"
  else
    ok "port ${port} free"
  fi
done

# --- .env.dev + boot gates (mirror apps/api/src/env.ts) ---
if [ -f "$ENV_FILE" ]; then
  ok ".env.dev exists"
else
  miss ".env.dev missing (cp .env.dev.example .env.dev and fill the blanks)"
fi

origin=$(env_val APP_ORIGIN)
if [ -z "$origin" ]; then
  miss "APP_ORIGIN unset (want e.g. http://127.0.0.1:5174)"
elif [[ "$origin" =~ ^https?://[^/[:space:]]+(:[0-9]+)?(/.*)?$ ]]; then
  ok "APP_ORIGIN $origin"
else
  miss "APP_ORIGIN must be a valid http(s) origin, got $origin"
fi

showcase_raw=$(env_val SHOWCASE_MODE)
if [ "$showcase_raw" = "false" ]; then
  gh_id=$(env_val GITHUB_CLIENT_ID)
  gh_secret=$(env_val GITHUB_CLIENT_SECRET)
  ops=$(env_val OPERATOR_EMAILS)
  if { [ -n "$gh_id" ] || [ -n "$gh_secret" ]; } && { [ -z "$gh_id" ] || [ -z "$gh_secret" ]; }; then
    miss "SHOWCASE_MODE=false with half-paired GITHUB_CLIENT_ID/SECRET (set both or neither)"
  elif [ -z "$gh_id" ] && [ -z "$gh_secret" ]; then
    miss "SHOWCASE_MODE=false requires an OAuth provider (GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET)"
  else
    ok "GitHub OAuth pair present"
  fi
  if [ -z "$ops" ]; then
    miss "SHOWCASE_MODE=false requires OPERATOR_EMAILS"
  else
    ok "OPERATOR_EMAILS set"
  fi
else
  ok "SHOWCASE_MODE=${showcase_raw:-<default true>} (persona login, no OAuth needed)"
fi

# --- worker env (WARN-only; web/API still run without these) ---
prefix=$(env_val IPV6_PREFIX)
if [ -z "$prefix" ]; then
  warn "IPV6_PREFIX empty (v6/SSH off; worker still provisions VMs + route files)"
elif [ "$prefix" = "2a11:6c7:f35:ea" ]; then
  warn "IPV6_PREFIX is the prod prefix on a non-prod .env.dev (dev VMs get prod-range v6)"
else
  ok "IPV6_PREFIX $prefix"
fi

if [ -z "$(env_val CF_DNS_API_TOKEN)" ]; then
  warn "CF_DNS_API_TOKEN empty (worker skips ALL AAAA writes)"
else
  ok "CF_DNS_API_TOKEN set"
fi

# --- incus socket (WARN-only; laptop without incus can still run web/API) ---
sock=/var/lib/incus/unix.socket
if [ -S "$sock" ] && [ -r "$sock" ] && [ -w "$sock" ]; then
  ok "incus socket present + RW"
else
  warn "incus socket $sock missing or not RW (worker container needs the mount)"
fi

# --- host capacity (mirror infra/host/check.sh thresholds, dev-sized disk) ---
cores=$(nproc 2>/dev/null || echo 0)
[ "${cores:-0}" -ge 4 ] && ok "CPU ${cores} cores" || miss "CPU ${cores} cores (<4)"

mem_gb=$(free -g | awk '/^Mem:/ {print $2}')
[ "${mem_gb:-0}" -ge 16 ] && ok "RAM ${mem_gb}G" || miss "RAM ${mem_gb}G (<16G)"

avail_gb=$(df -BG "$PWD" | awk 'NR==2 {gsub(/G/, "", $4); print $4}')
[ "${avail_gb:-0}" -ge 50 ] && ok "disk ${avail_gb}G free on \$PWD" || miss "disk ${avail_gb}G free on \$PWD (<50G)"

# --- incus group vs compose worker group_add 986 (WARN-only) ---
incus_gid=$(getent group incus 2>/dev/null | cut -d: -f3)
if [ -z "$incus_gid" ]; then
  printf 'info no local incus group (GID check skipped)\n'
elif [ "$incus_gid" = "986" ]; then
  ok "incus GID 986 matches compose group_add"
else
  warn "host incus GID $incus_gid != compose group_add 986 (worker may lack socket RW)"
fi

# --- optional DNS probe (WARN-only; skipped without dig/BASE_DOMAIN) ---
base=$(env_val BASE_DOMAIN)
if command -v dig >/dev/null 2>&1 && [ -n "$base" ]; then
  probe="probe-vnc.${base}"
  got=$(dig +short +time=2 +tries=1 A "$probe" @1.1.1.1 2>/dev/null | head -1)
  printf 'info desktop wildcard probe %s -> %s (want edge host A)\n' "$probe" "${got:-<none>}"
else
  printf 'info desktop DNS probe skipped (needs dig + BASE_DOMAIN)\n'
fi

[ "$fail" -eq 0 ] && printf 'READY\n' || printf 'NOT READY (see MISS lines)\n'

exit "$fail"
