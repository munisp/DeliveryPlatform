#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROW_COUNT="${ROW_COUNT:-500}"
CACHE_DURATION_SECONDS="${CACHE_DURATION_SECONDS:-3}"
REDIS_PORT="${REDIS_PORT:-$((20000 + (RANDOM % 10000)))}"
REDIS_DIR="$(mktemp -d /tmp/deliveryplatform-redis-isolation.XXXXXX)"
REDIS_PID=""
CACHE_LOAD_PID=""

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  }
}

cleanup() {
  status=$?
  set +e
  if [[ -n "$CACHE_LOAD_PID" ]] && kill -0 "$CACHE_LOAD_PID" >/dev/null 2>&1; then
    kill "$CACHE_LOAD_PID" >/dev/null 2>&1 || true
    wait "$CACHE_LOAD_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$REDIS_PID" ]] && kill -0 "$REDIS_PID" >/dev/null 2>&1; then
    redis-cli -h 127.0.0.1 -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
    wait "$REDIS_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$REDIS_DIR"
  exit "$status"
}
trap cleanup EXIT

[[ "$ROW_COUNT" =~ ^[1-9][0-9]*$ && "$ROW_COUNT" -le 50000 ]] || {
  printf 'ROW_COUNT must be an integer from 1 through 50000\n' >&2
  exit 1
}
[[ "$CACHE_DURATION_SECONDS" =~ ^[1-9][0-9]*$ && "$CACHE_DURATION_SECONDS" -le 30 ]] || {
  printf 'CACHE_DURATION_SECONDS must be an integer from 1 through 30\n' >&2
  exit 1
}
[[ "$REDIS_PORT" =~ ^[1-9][0-9]{3,4}$ ]] || {
  printf 'REDIS_PORT must be a TCP port from 1000 through 99999\n' >&2
  exit 1
}

for required in redis-server redis-cli python3 sudo; do
  require_command "$required"
done
[[ -x "$ROOT/scripts/testing/benchmark-settlement-reconciliation.sh" ]] || {
  printf '%s\n' 'settlement benchmark harness is unavailable' >&2
  exit 1
}

start_redis() {
  redis-server \
    --bind 127.0.0.1 \
    --port "$REDIS_PORT" \
    --save '' \
    --appendonly no \
    --protected-mode yes \
    --dir "$REDIS_DIR" \
    --logfile "$REDIS_DIR/redis.log" \
    --pidfile "$REDIS_DIR/redis.pid" \
    --daemonize no >"$REDIS_DIR/redis.stdout" 2>&1 &
  REDIS_PID=$!
  for _ in $(seq 1 40); do
    if redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  printf '%s\n' 'ephemeral Redis did not become ready' >&2
  return 1
}

start_cache_load() {
  python3 - "$REDIS_PORT" "$CACHE_DURATION_SECONDS" >"$REDIS_DIR/cache-load.log" 2>&1 <<'PY' &
import socket
import sys
import time

port = int(sys.argv[1])
duration = int(sys.argv[2])
deadline = time.monotonic() + duration + 5
attempts = 0
successes = 0
failures = 0
while time.monotonic() < deadline:
    attempts += 1
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.2) as conn:
            conn.settimeout(0.2)
            conn.sendall(b"*1\r\n$4\r\nPING\r\n")
            response = conn.recv(64)
            if response.startswith(b"+PONG"):
                successes += 1
            else:
                failures += 1
    except OSError:
        failures += 1
print(f"cache_probe_attempts={attempts}")
print(f"cache_probe_successes={successes}")
print(f"cache_probe_failures={failures}")
PY
  CACHE_LOAD_PID=$!
}

run_settlement_benchmark() {
  REDIS_URL="redis://127.0.0.1:${REDIS_PORT}/0" \
    ROW_COUNT="$ROW_COUNT" \
    "$ROOT/scripts/testing/benchmark-settlement-reconciliation.sh"
}

printf '%s\n' '=== Settlement reconciliation Redis isolation test ==='
printf 'row_count=%s\n' "$ROW_COUNT"
printf 'cache_fault_window_seconds=%s\n' "$CACHE_DURATION_SECONDS"
printf 'redis_port=%s\n' "$REDIS_PORT"

start_redis
start_cache_load

printf '%s\n' '=== Bounded cache latency injection ==='
redis-cli -h 127.0.0.1 -p "$REDIS_PORT" client pause "$((CACHE_DURATION_SECONDS * 1000))" all >/dev/null
run_settlement_benchmark >"$REDIS_DIR/latency-benchmark.log" 2>&1
wait "$CACHE_LOAD_PID"
CACHE_LOAD_PID=""

grep -Fq 'financial_table_counts_before_after=' "$REDIS_DIR/latency-benchmark.log"
grep -Fq 'provider_only:' "$REDIS_DIR/latency-benchmark.log"
grep -Eq 'cache_probe_failures=[1-9][0-9]*' "$REDIS_DIR/cache-load.log" || {
  printf '%s\n' 'cache latency injection did not produce a bounded cache-probe failure' >&2
  cat "$REDIS_DIR/cache-load.log" >&2
  exit 1
}

printf '%s\n' '=== Bounded cache outage injection ==='
start_cache_load
redis-cli -h 127.0.0.1 -p "$REDIS_PORT" shutdown nosave >/dev/null
wait "$REDIS_PID" || true
REDIS_PID=""
run_settlement_benchmark >"$REDIS_DIR/outage-benchmark.log" 2>&1
wait "$CACHE_LOAD_PID"
CACHE_LOAD_PID=""

grep -Fq 'financial_table_counts_before_after=' "$REDIS_DIR/outage-benchmark.log"
grep -Fq 'provider_only:' "$REDIS_DIR/outage-benchmark.log"
grep -Eq 'cache_probe_failures=[1-9][0-9]*' "$REDIS_DIR/cache-load.log" || {
  printf '%s\n' 'cache outage injection did not produce a bounded cache-probe failure' >&2
  cat "$REDIS_DIR/cache-load.log" >&2
  exit 1
}

printf '%s\n' 'redis_latency_reconciliation=PASS'
printf '%s\n' 'redis_outage_reconciliation=PASS'
printf '%s\n' 'settlement_reconciliation_financial_isolation=PASS'
printf '%s\n' 'NOTE: The settlement runner intentionally does not use Redis; these scenarios prove cache loss does not create financial mutations or block reconciliation completion.'
