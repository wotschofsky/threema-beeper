#!/bin/sh
set -eu
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cc -O2 -Wall -Wextra -Werror /source/native/media-limits.c -o "$work/limits"
cc -O2 -Wall -Wextra -Werror /source/tests/media-limits-probe.c -o "$work/probe"
SYNTHETIC_SECRET=not-a-secret "$work/limits" 1 33554432 1024 "$work/probe" limits
"$work/limits" 1 33554432 1024 "$work/probe" memory
set +e
"$work/limits" 1 33554432 1024 "$work/probe" cpu
code=$?
set -e
[ "$code" -eq 137 ]
for invalid in 0 -1 301 1x; do
    set +e
    "$work/limits" "$invalid" 33554432 1024 "$work/probe" limits 2>/dev/null
    code=$?
    set -e
    [ "$code" -eq 125 ]
done
printf 'Linux codec limits: CPU kill, allocation bound, hard limits, environment and input validation pass\n'
