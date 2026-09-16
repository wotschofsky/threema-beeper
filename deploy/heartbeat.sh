#!/bin/sh
set -eu
# The external monitor notices missing pings even when this command cannot run.
exec docker compose -f compose.yaml -f compose.monitoring.yaml exec -T bridge \
  node src/service/entry.heartbeat.ts /installation/bridge.yaml /monitoring/heartbeat-url
