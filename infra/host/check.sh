#!/usr/bin/env bash
# Read-only readiness probe for a Homehost host. Never mutates anything.
# Usage: bash infra/host/check.sh
set -u

fail=0
ok() { printf 'ok   %s\n' "$1"; }
miss() { printf 'MISS %s\n' "$1"; fail=1; }

[ -c /dev/kvm ] && ok "/dev/kvm present" || miss "/dev/kvm missing (enable VT-x/AMD-V in firmware)"
grep -q -E '^(flags.*(vmx|svm))' /proc/cpuinfo 2>/dev/null \
  && ok "CPU virtualization flags" || miss "CPU virtualization flags"

for bin in incus docker; do
  if command -v "$bin" >/dev/null 2>&1; then
    ok "$bin $($bin --version 2>/dev/null | head -1)"
  else
    miss "$bin not installed"
  fi
done

mem_gb=$(free -g | awk '/^Mem:/ {print $2}')
[ "${mem_gb:-0}" -ge 16 ] && ok "RAM ${mem_gb}G" || miss "RAM ${mem_gb}G (<16G thin for tenants)"

avail_gb=$(df -BG / | awk 'NR==2 {gsub(/G/, "", $4); print $4}')
[ "${avail_gb:-0}" -ge 100 ] && ok "disk ${avail_gb}G free on /" || miss "disk ${avail_gb}G free (<100G)"

if command -v incus >/dev/null 2>&1 && incus info >/dev/null 2>&1; then
  ok "incus daemon reachable"
  incus storage list --format csv 2>/dev/null | grep -q . \
    && ok "incus storage pools: $(incus storage list --format csv 2>/dev/null | cut -d, -f1 | tr '\n' ' ')" \
    || miss "no incus storage pool (run host:setup)"
else
  miss "incus daemon not initialized"
fi

for port in 80 443; do
  if ss -tln 2>/dev/null | grep -q ":${port} "; then
    miss "port ${port} already bound (Traefik will need it)"
  else
    ok "port ${port} free"
  fi
done

pub=$(curl -fsS --max-time 8 ifconfig.me 2>/dev/null || echo UNKNOWN)
printf 'info public IP as seen from internet: %s\n' "$pub"
printf 'info if that is 100.64-127.x.x you are behind CGNAT: inbound ports die at the ISP\n'
printf 'info compare it with your router WAN IP; a mismatch also means CGNAT/NAT\n'

  # --- Desktop GUI edge probe (additive, read-only) ---
  # Verifies the Traefik edge can serve per-desktop <label>-vnc hostnames:
  # route files present, wildcard desktop DNS resolves to this edge host.
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^homehost-edge-traefik-1$'; then
    ok "edge traefik container running"
    gui_count=$(ls infra/traefik/routes/gui-*.yml 2>/dev/null | wc -l)
    printf 'info desktop route files (gui-*.yml): %s\n' "$gui_count"
    if command -v dig >/dev/null 2>&1 && [ -n "${BASE_DOMAIN:-}" ]; then
      probe="probe-vnc.${BASE_DOMAIN}"
      got=$(dig +short A "$probe" @1.1.1.1 2>/dev/null | head -1)
      got6=$(dig +short AAAA "$probe" @1.1.1.1 2>/dev/null | head -1)
      printf 'info desktop wildcard probe %s -> %s %s (want edge host A/AAAA)\n' "$probe" "${got:-<none>}" "${got6:-<none>}"
    fi
else
  printf 'info edge traefik not running here (desktop probe skipped)\n'
fi
[ "$fail" -eq 0 ] && printf 'READY\n' || printf 'NOT READY (see MISS lines)\n'

exit "$fail"
