#!/usr/bin/env bash
# Restart the host worker on this checkout and confirm it booted.
# The unit runs from source, not an image, so rebuilding containers alone
# leaves it on the previous commit. Restart=always would also hide a crash
# loop behind a successful `systemctl restart`, so wait for the boot line.
set -euo pipefail

unit=homehost-worker
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
