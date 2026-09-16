#!/bin/sh
# Run on the Linux host, from the directory containing compose.yaml.
set -eu
umask 077
: "${BACKUP_DIR:?Set an absolute private backup directory owned by UID 1000}"
: "${BACKUP_KEY:?Set the absolute path to a separate backup key readable by UID 1000}"
: "${BACKUP_KEEP:=30}"
case "$BACKUP_KEEP" in ''|*[!0-9]*) echo 'BACKUP_KEEP must be 0 or 2 through 3650' >&2; exit 2;; esac
if [ "$BACKUP_KEEP" -ne 0 ] && { [ "$BACKUP_KEEP" -lt 2 ] || [ "$BACKUP_KEEP" -gt 3650 ]; }; then
  echo 'BACKUP_KEEP must be 0 or 2 through 3650' >&2; exit 2
fi
case "$BACKUP_DIR:$BACKUP_KEY" in /*:/*) ;; *) echo 'Backup paths must be absolute' >&2; exit 2;; esac
exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || exit 0
was_running=''
finish_backup() {
  result=$?
  trap - EXIT
  set +e
  if [ -n "$was_running" ]; then
    docker compose start bridge
    restart_result=$?
    if [ "$restart_result" -ne 0 ]; then result=$restart_result; fi
  fi
  outcome=success
  if [ "$result" -ne 0 ]; then outcome=failed; fi
  docker compose run --rm --no-deps --entrypoint node bridge \
    src/backup/entry.status.ts /installation/data/maintenance/backup "$outcome"
  status_result=$?
  if [ "$result" -eq 0 ] && [ "$status_result" -ne 0 ]; then result=$status_result; fi
  exit "$result"
}
trap finish_backup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
was_running=$(docker compose ps --status running -q bridge)
docker compose stop bridge
backup_name="bridge-$(date -u +%Y%m%dT%H%M%SZ).enc"
docker compose run --rm --no-deps \
  -v "$BACKUP_DIR:/backups" -v "$BACKUP_KEY:/backup-key:ro" \
  --entrypoint node bridge src/backup/entry.backup.ts create \
  /installation/bridge.yaml /backup-key "/backups/$backup_name"
if [ "$BACKUP_KEEP" -ne 0 ]; then
  docker compose run --rm --no-deps -v "$BACKUP_DIR:/backups" \
    --entrypoint node bridge src/backup/entry.retention.ts /backups "$backup_name" "$BACKUP_KEEP"
fi
