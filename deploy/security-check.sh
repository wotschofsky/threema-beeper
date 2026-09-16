#!/bin/sh
# Linux host; run from the directory containing compose.yaml. Never starts a linked account.
set -eu
umask 077
mkdir -p maintenance/security-scanner
exec 9>maintenance/security-scanner/check.lock
flock -n 9 || exit 0
finish_scan() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then
    docker compose run --rm -T --no-deps --entrypoint node bridge \
      src/service/entry.security-scan-result.ts /installation/data/maintenance/security failed || true
  fi
  exit "$result"
}
trap finish_scan EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Pins are supplied with the reviewed host tools, never downloaded at job startup.
for tool in syft grype; do
  expected=$(cat "scanner-tools/$tool.sha256")
  case "$expected" in ''|*[!a-f0-9]*) echo 'Invalid scanner pin' >&2; exit 1;; esac
  [ "${#expected}" -eq 64 ] || exit 1
  printf '%s  %s\n' "$expected" "scanner-tools/$tool" | sha256sum -c - >/dev/null
done
container=$(docker compose ps --all -q bridge)
[ -n "$container" ] || { echo 'No installed bridge container' >&2; exit 1; }
image=$(docker inspect --format '{{.Image}}' "$container")
case "$image" in sha256:*) ;; *) echo 'Invalid installed image identity' >&2; exit 1;; esac
# Explicit config and a clean environment prevent inherited ignore/cataloger settings.
cat >maintenance/security-scanner/syft.json <<'JSON'
{"check-for-app-update":false}
JSON
cat >maintenance/security-scanner/grype.json <<'JSON'
{"check-for-app-update":false,"db":{"cache-dir":"./maintenance/security-scanner/db","auto-update":false},"ignore":[]}
JSON
clean_tool() {
  env -i PATH="$PATH" HOME="$PWD/maintenance/security-scanner" "$@"
}
clean_tool ./scanner-tools/grype --config maintenance/security-scanner/grype.json db update
clean_tool ./scanner-tools/grype --config maintenance/security-scanner/grype.json db status -o json >maintenance/security-scanner/database.next.json
docker compose run --rm -T --no-deps --entrypoint node bridge \
  src/service/entry.security-database.ts <maintenance/security-scanner/database.next.json
clean_tool ./scanner-tools/syft scan "docker:$image" --config maintenance/security-scanner/syft.json \
  -o syft-json >maintenance/security-scanner/inventory.next.json
clean_tool ./scanner-tools/grype --config maintenance/security-scanner/grype.json \
  sbom:maintenance/security-scanner/inventory.next.json -o json >maintenance/security-scanner/report.next.json
# An upgrade during scanning invalidates this observation; retry on the next run.
current=$(docker compose ps --all -q bridge)
[ "$current" = "$container" ] && [ "$(docker inspect --format '{{.Image}}' "$current")" = "$image" ] || exit 1
docker compose run --rm -T --no-deps --entrypoint node bridge \
  src/service/entry.security-scan-result.ts /installation/data/maintenance/security "$image" \
  <maintenance/security-scanner/report.next.json
mv maintenance/security-scanner/database.next.json maintenance/security-scanner/database.json
mv maintenance/security-scanner/inventory.next.json maintenance/security-scanner/inventory.json
mv maintenance/security-scanner/report.next.json maintenance/security-scanner/report.json
