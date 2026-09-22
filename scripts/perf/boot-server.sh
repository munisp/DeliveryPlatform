#!/bin/sh
# boot-server.sh — boot the DeliveryPlatform server (tsx, dev mode) on :3005
# with the perf-harness environment. Run from the repo root:
#   sh scripts/perf/boot-server.sh
set -e
cd "$(dirname "$0")/../.."
set -a
. ./scripts/perf/perf.env
set +a
exec node_modules/.bin/tsx server/_core/index.ts
