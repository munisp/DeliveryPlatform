#!/bin/sh
# boot-services.sh — build (if needed) and start the satellite services used
# by the perf harness service-to-service benchmarks. Run from the repo root:
#   sh scripts/perf/boot-services.sh
# Requires: go 1.23+, cargo, python3 with fastapi/uvicorn/psycopg installed.
set -e
cd "$(dirname "$0")/../.."
set -a
. ./scripts/perf/perf.env
set +a

mkdir -p /tmp/perf-bin /tmp/perf-logs

# Rust work-record-signer (:8109)
if [ ! -x /tmp/perf-bin/work-record-signer ]; then
  (cd services/rust/work-record-signer && cargo build --release)
  cp services/rust/work-record-signer/target/release/work-record-signer /tmp/perf-bin/
fi
nohup env PORT=8109 BIND_HOST=127.0.0.1 \
  WORK_RECORD_SIGNER_TOKEN="$WORK_RECORD_SIGNER_TOKEN" \
  WORK_RECORD_SIGNER_SEED="$WORK_RECORD_SIGNER_SEED" \
  /tmp/perf-bin/work-record-signer > /tmp/perf-logs/signer.log 2>&1 &

# Go notification-dispatcher (:8099) and safety-engine (:8107)
if [ ! -x /tmp/perf-bin/notification-dispatcher ]; then
  (cd services/go/notification-dispatcher && go build -o /tmp/perf-bin/notification-dispatcher .)
fi
nohup env PORT=8099 INTERNAL_SERVICE_TOKEN="$INTERNAL_SERVICE_TOKEN" DATABASE_URL="$DATABASE_URL" \
  /tmp/perf-bin/notification-dispatcher > /tmp/perf-logs/notification-dispatcher.log 2>&1 &

if [ ! -x /tmp/perf-bin/safety-engine ]; then
  (cd services/go/safety-engine && go build -o /tmp/perf-bin/safety-engine .)
fi
nohup env PORT=8107 INTERNAL_SERVICE_TOKEN="$INTERNAL_SERVICE_TOKEN" DATABASE_URL="$DATABASE_URL" \
  /tmp/perf-bin/safety-engine > /tmp/perf-logs/safety-engine.log 2>&1 &

# Python lakehouse (:8007)
nohup env PORT=8007 BIND_HOST=127.0.0.1 DATABASE_URL="$DATABASE_URL" \
  INTERNAL_SERVICE_TOKEN="$INTERNAL_SERVICE_TOKEN" \
  sh -c 'cd services/python/lakehouse && exec python3 main.py' > /tmp/perf-logs/lakehouse.log 2>&1 &

sleep 5
for url in http://127.0.0.1:8109/healthz http://127.0.0.1:8099/health http://127.0.0.1:8107/health http://127.0.0.1:8007/health; do
  printf "%s -> " "$url"
  curl -s -m 5 -o /dev/null -w "%{http_code}\n" "$url" || echo down
done
