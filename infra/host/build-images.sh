#!/usr/bin/env bash
# Bakes the homehost-owned Incus images every plan launches from, so first
# boot only does per-box config (users, keys, passwords, v6, KasmVNC user)
# instead of apt. Each image is launched from images:, upgraded, given the
# packages every box of that kind needs, scrubbed of per-box identity (apt
# lists, cloud-init state, machine-id, ssh host keys, snakeoil cert) and
# published into the default project under a stable alias. The worker copies
# the aliased image into tenant projects on demand (internal/incus).
#
# Idempotent: a rerun publishes a fresh build (picking up security updates),
# moves the alias to it, then deletes the previous version.
# Weekly via homehost-images.timer; see infra/host/README.md.
#
# Usage: bash infra/host/build-images.sh [container] [vm] [desktop]  (default: all)
# Needs incus-admin (or root), jq.
set -euo pipefail

# Alias -> what to build. Plan images in packages/shared/src/plans.ts point here.
CONTAINER_ALIAS=homehost/ubuntu-24.04/container
VM_ALIAS=homehost/ubuntu-24.04/vm
DESKTOP_ALIAS=homehost/ubuntu-24.04/desktop-xfce

KASMVNC_VERSION=1.3.3
KASMVNC_DEB="kasmvncserver_noble_${KASMVNC_VERSION}_amd64.deb"
# KasmVNC is not in the Ubuntu archives; the deb comes from GitHub releases.
KASMVNC_URL="https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/${KASMVNC_DEB}"
# xfce4 desktop + KasmVNC runtime needs (xauth, sudo, ssl-cert for the TLS cert).
DESKTOP_PACKAGES="xfce4 tigervnc-standalone-server dbus-x11 ssl-cert websockify xauth sudo"

command -v jq >/dev/null || { echo "build-images: jq is required" >&2; exit 1; }

log() { printf '%s build-images: %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# Runs a shell script in the guest with stdin closed.
guest() { incus exec "$1" -- sh -euc "$2" </dev/null; }

wait_for() { # name, description, test script, timeout seconds
  local deadline=$((SECONDS + $4))
  until guest "$1" "$3" >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$deadline" ] || { echo "build-images: $1: timed out waiting for $2" >&2; return 1; }
    sleep 2
  done
}

# Apt runs over IPv4 only: tenant bridges have no IPv6 egress route.
APT='export DEBIAN_FRONTEND=noninteractive
apt_get() { apt-get -o Acquire::ForceIPv4=true -o Dpkg::Options::=--force-confold -y "$@"; }
apt_get update
apt_get full-upgrade
'

# Per-box identity must never ship in an image: every box regenerates ssh
# host keys (cloud-init on VMs, the worker's sshd setup in containers), its
# machine-id and, on desktops, the KasmVNC TLS cert.
SCRUB='apt-get clean
rm -rf /var/lib/apt/lists/*
rm -f /etc/ssh/ssh_host_*
rm -f /etc/ssl/private/ssl-cert-snakeoil.key /etc/ssl/certs/ssl-cert-snakeoil.pem
if command -v cloud-init >/dev/null 2>&1; then
  # The bake boot created the cloud-init default user; boxes create their own.
  if id ubuntu >/dev/null 2>&1; then userdel -r ubuntu 2>/dev/null || userdel ubuntu; fi
  rm -f /etc/sudoers.d/90-cloud-init-users
  cloud-init clean --logs --machine-id
else
  truncate -s 0 /etc/machine-id
fi
rm -f /var/lib/dbus/machine-id /root/.bash_history
journalctl --rotate >/dev/null 2>&1 && journalctl --vacuum-time=1s >/dev/null 2>&1 || true
sync
'

build() { # kind alias source vm(0|1) install-script
  local kind=$1 alias=$2 source=$3 vm=$4 install=$5
  local name="hh-build-${kind}-$$"
  local launch=(incus launch "$source" "$name" -c limits.cpu=4 -c limits.memory=4GiB)
  [ "$vm" = 1 ] && launch+=(--vm)
  trap 'incus delete -f "'"$name"'" >/dev/null 2>&1 || true' EXIT

  log "$alias: launching $source as $name"
  "${launch[@]}" >/dev/null
  wait_for "$name" "guest agent" true 300
  if [ "$vm" = 1 ]; then
    # Let the bake boot's own cloud-init run finish before touching apt.
    guest "$name" 'cloud-init status --wait >/dev/null || true'
  fi
  wait_for "$name" "network" 'ip -4 route show default | grep -q .' 120

  log "$alias: installing"
  guest "$name" "$APT$install"
  log "$alias: scrubbing per-box state"
  guest "$name" "$SCRUB"
  incus stop "$name"

  log "$alias: publishing"
  local out fp old
  out=$(incus publish "$name" --compression zstd "homehost.image=$alias" \
    "description=homehost $kind ($(date -u +%Y-%m-%d))")
  fp=$(printf '%s\n' "$out" | sed -n 's/.*fingerprint: *\([0-9a-f]\{64\}\).*/\1/p')
  [ -n "$fp" ] || { echo "build-images: $alias: no fingerprint in publish output: $out" >&2; return 1; }

  old=$(incus query "/1.0/images/aliases/$alias" 2>/dev/null | jq -r '.target // empty' || true)
  if [ -n "$old" ]; then
    incus query -X PUT "/1.0/images/aliases/$alias" \
      --data "$(jq -nc --arg t "$fp" --arg d "homehost $kind" '{target: $t, description: $d}')" >/dev/null
  else
    incus image alias create "$alias" "$fp" --description "homehost $kind"
  fi
  log "$alias -> ${fp:0:12}"

  # Drop every older build of this alias (previous version, interrupted runs).
  incus query "/1.0/images?recursion=1" \
    | jq -r --arg a "$alias" --arg fp "$fp" \
      '.[] | select(.properties["homehost.image"] == $a and .fingerprint != $fp) | .fingerprint' \
    | while read -r stale; do
      log "$alias: deleting old version ${stale:0:12}"
      incus image delete "$stale"
    done

  incus delete -f "$name" >/dev/null
  trap - EXIT
}

build_container() {
  build container "$CONTAINER_ALIAS" images:ubuntu/24.04 0 'apt_get install openssh-server'
}

build_vm() {
  build vm "$VM_ALIAS" images:ubuntu/24.04/cloud 1 'apt_get install openssh-server'
}

build_desktop() {
  build desktop "$DESKTOP_ALIAS" images:ubuntu/24.04/cloud 1 "apt_get install openssh-server curl $DESKTOP_PACKAGES
curl -fsSL -o /tmp/$KASMVNC_DEB $KASMVNC_URL
apt_get install /tmp/$KASMVNC_DEB
rm -f /tmp/$KASMVNC_DEB"
}

kinds=("$@")
[ "${#kinds[@]}" -gt 0 ] || kinds=(container vm desktop)
for kind in "${kinds[@]}"; do
  case "$kind" in
    container | vm | desktop) "build_$kind" ;;
    *) echo "build-images: unknown kind $kind (container|vm|desktop)" >&2; exit 2 ;;
  esac
done
log "done"
