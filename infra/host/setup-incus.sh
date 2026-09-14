#!/usr/bin/env bash
# Idempotent Incus installer for Ubuntu 24.04+ hosts. Safe to re-run.
# Creates a ZFS loop pool (pilot-grade; replace with a real disk for production).
# Usage: POOL_SIZE_GB=200 sudo -E bash infra/host/setup-incus.sh
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
POOL_SIZE_GB="${POOL_SIZE_GB:-200}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CALLER="${SUDO_USER:-}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq incus zfsutils-linux

if ! incus info >/dev/null 2>&1; then
  sed "s/@POOL_SIZE@/${POOL_SIZE_GB}GiB/" "${SCRIPT_DIR}/incus-preseed.yml.tpl" \
    | incus admin init --preseed
  echo "incus initialized: zfs pool 'homehost' (${POOL_SIZE_GB}GiB loop), bridge incusbr0"
else
  echo "incus already initialized; converging pool/network/profile below"
fi

# Converge: a daemon initialized without the preseed still ends up with the
# pilot pool, bridge and default profile devices. Each step skips when present.
incus storage show homehost >/dev/null 2>&1 \
  || incus storage create homehost zfs "size=${POOL_SIZE_GB}GiB" source=/var/lib/incus/disks/homehost.img
incus network show incusbr0 >/dev/null 2>&1 \
  || incus network create incusbr0 ipv4.address=10.0.0.1/24 ipv4.nat=true ipv6.address=none
incus profile show default | grep -q '^  root:$' \
  || incus profile device add default root disk path=/ pool=homehost
incus profile show default | grep -q '^  eth0:$' \
  || incus profile device add default eth0 nic network=incusbr0 name=eth0

if [ -n "$CALLER" ] && ! id -nG "$CALLER" | grep -qw incus-admin; then
  adduser "$CALLER" incus-admin
  echo "added $CALLER to incus-admin (log out/in for it to apply)"
fi

incus info >/dev/null
incus storage list
incus network show incusbr0
echo "DONE"
