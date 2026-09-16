#!/bin/sh
set -eu
exec docker compose exec -T bridge node src/service/entry.upstream-monitor.ts \
  /installation/data/maintenance/upstream
