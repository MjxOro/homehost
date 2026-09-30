#!/usr/bin/env bash
# Keeps the tenant /64 gateway (<IPV6_PREFIX>::ffff/64) on incusbr0.
#
# incusbr0 runs with ipv6.address=none, so whenever the Incus daemon
# (re)starts (package upgrades restart it too) it brings the bridge back with
# IPv6 disabled. That drops this address and the on-link /64 route: Route64
# still delivers box traffic to the host over WireGuard, but the host has
# nowhere to send it, so every box loses IPv6 at once.
#
# Idempotent, run at boot, after every Incus start and every 30s by
# homehost-brnet.timer. Silent unless it had to repair something.
set -euo pipefail

env_file="${1:?usage: homehost-brnet <worker.env>}"
dev=incusbr0

# Same derivation as the worker (apps/worker/src/index.ts): strip trailing
# colons from IPV6_PREFIX, then append ::ffff.
prefix="$(sed -n 's/^IPV6_PREFIX=//p' "$env_file" | tail -n 1)"
prefix="${prefix%\"}"
prefix="${prefix#\"}"
prefix="${prefix%%/*}"
while [[ "$prefix" == *: ]]; do prefix="${prefix%:}"; done
if [[ -z "$prefix" ]]; then
  echo "<3>IPV6_PREFIX missing in ${env_file}" >&2
  exit 1
fi
gateway="${prefix}::ffff"

# Bridge not created yet (Incus still starting): the next run catches it.
[[ -e "/sys/class/net/${dev}" ]] || exit 0

repaired=()
if [[ "$(sysctl -n "net.ipv6.conf.${dev}.disable_ipv6")" != 0 ]]; then
  sysctl -qw "net.ipv6.conf.${dev}.disable_ipv6=0"
  repaired+=("re-enabled IPv6")
fi
if ! ip -6 -o addr show dev "$dev" scope global | grep -qF " ${gateway}/64 "; then
  ip -6 addr replace "${gateway}/64" dev "$dev"
  repaired+=("restored ${gateway}/64")
fi
if ((${#repaired[@]})); then
  echo "<5>${dev}: ${repaired[*]}"
fi
