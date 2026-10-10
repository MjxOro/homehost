#!/usr/bin/env bash
# Build the worker from this checkout, install its unit if it changed, restart
# it and confirm it booted. The unit runs a binary built here, not an image,
# so rebuilding containers alone leaves it on the previous commit.
# Restart=always would also hide a crash loop behind a successful
# `systemctl restart`, so wait for the boot line.
set -euo pipefail

unit=homehost-worker
repo=$(git rev-parse --show-toplevel)
bin="$repo/apps/worker/bin/homehost-worker"

# Build beside the live binary and swap atomically: a failed build leaves the
# running worker untouched and fails the deploy here.
mkdir -p "$(dirname "$bin")"
go -C "$repo/apps/worker" build -trimpath -o "$bin.new" .
mv -f "$bin.new" "$bin"

installed=/etc/systemd/system/$unit.service
if ! cmp -s "$repo/infra/worker/$unit.service" "$installed"; then
  sudo install -m 644 "$repo/infra/worker/$unit.service" "$installed"
  sudo systemctl daemon-reload
  echo "$unit.service updated"
fi

since=$(date '+%Y-%m-%d %H:%M:%S')
sudo systemctl restart "$unit"
for _ in $(seq 1 30); do
  if sudo journalctl -u "$unit" --since "$since" --no-pager -q | grep -q 'worker up'; then
    echo "$unit restarted on $(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 1
done
echo "$unit did not log 'worker up' within 30s:" >&2
sudo journalctl -u "$unit" --since "$since" --no-pager -n 30 >&2
exit 1
