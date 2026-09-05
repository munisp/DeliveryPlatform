#!/usr/bin/env bash
set -euo pipefail

EXPECTED_CONTEXT="${EXPECTED_CONTEXT:?EXPECTED_CONTEXT is required}"
NAMESPACE="${NAMESPACE:-resilience-test}"
TARGET_ENV="${TARGET_ENV:?TARGET_ENV is required}"
RESILIENCE_CHANGE_ID="${RESILIENCE_CHANGE_ID:?RESILIENCE_CHANGE_ID is required}"
CONFIRM_NON_PRODUCTION="${CONFIRM_NON_PRODUCTION:?CONFIRM_NON_PRODUCTION is required}"
TOXIPROXY_API_URL="${TOXIPROXY_API_URL:-http://redis-chaos-toxiproxy.${NAMESPACE}.svc.cluster.local:8474}"
PROXY_NAME="redis-chaos-cache"
PROXY_LISTEN="0.0.0.0:8667"
REDIS_UPSTREAM="redis-chaos-target.${NAMESPACE}.svc.cluster.local:6379"
MAX_DURATION_SECONDS=30
MAX_LATENCY_MS=2000
MAX_JITTER_MS=500
MAX_TIMEOUT_MS=10000
MAX_RESET_DELAY_MS=5000
proxy_armed=false

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  }
}

require_non_production() {
  [[ "$TARGET_ENV" == "test" || "$TARGET_ENV" == "staging" || "$TARGET_ENV" == "preproduction" ]] || {
    printf 'TARGET_ENV must be test, staging, or preproduction\n' >&2
    exit 1
  }
  [[ "$EXPECTED_CONTEXT" != *prod* && "$EXPECTED_CONTEXT" != *production* ]] || {
    printf 'EXPECTED_CONTEXT must not contain prod or production\n' >&2
    exit 1
  }
  [[ "$NAMESPACE" == "resilience-test" ]] || {
    printf 'NAMESPACE must be the dedicated resilience-test namespace\n' >&2
    exit 1
  }
  [[ "$CONFIRM_NON_PRODUCTION" == "${TARGET_ENV}:${NAMESPACE}:${RESILIENCE_CHANGE_ID}" ]] || {
    printf 'CONFIRM_NON_PRODUCTION must equal TARGET_ENV:NAMESPACE:RESILIENCE_CHANGE_ID\n' >&2
    exit 1
  }
  [[ "$TOXIPROXY_API_URL" =~ ^http://[A-Za-z0-9.-]+(:[1-9][0-9]*)?$ ]] || {
    printf 'TOXIPROXY_API_URL must be a plain HTTP DNS host and port without a path\n' >&2
    exit 1
  }
}

api() {
  local method="$1" path="$2" data="${3:-}"
  if [[ -n "$data" ]]; then
    curl --fail-with-body --silent --show-error --connect-timeout 3 --max-time 10 \
      -X "$method" -H 'content-type: application/json' --data "$data" "${TOXIPROXY_API_URL}${path}"
  else
    curl --fail-with-body --silent --show-error --connect-timeout 3 --max-time 10 \
      -X "$method" "${TOXIPROXY_API_URL}${path}"
  fi
}

ensure_proxy() {
  if ! api GET "/proxies/${PROXY_NAME}" >/dev/null 2>&1; then
    api POST /proxies "{\"name\":\"${PROXY_NAME}\",\"listen\":\"${PROXY_LISTEN}\",\"upstream\":\"${REDIS_UPSTREAM}\",\"enabled\":true}" >/dev/null
  fi
  api POST "/proxies/${PROXY_NAME}" '{"enabled":true}' >/dev/null
}

clear_faults() {
  api DELETE "/proxies/${PROXY_NAME}/toxics" >/dev/null 2>&1 || true
  api POST "/proxies/${PROXY_NAME}" '{"enabled":true}' >/dev/null 2>&1 || true
  proxy_armed=false
}

cleanup() {
  local status=$?
  if [[ "$proxy_armed" == true ]]; then
    clear_faults
    printf '%s\n' 'redis chaos cleanup completed'
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

bounded_integer() {
  local value="$1" minimum="$2" maximum="$3" label="$4"
  [[ "$value" =~ ^[0-9]+$ ]] && (( value >= minimum && value <= maximum )) || {
    printf '%s must be an integer from %s through %s\n' "$label" "$minimum" "$maximum" >&2
    exit 1
  }
}

add_toxic() {
  local name="$1" type="$2" stream="$3" attributes="$4"
  api POST "/proxies/${PROXY_NAME}/toxics" "{\"name\":\"${name}\",\"type\":\"${type}\",\"stream\":\"${stream}\",\"toxicity\":1.0,\"attributes\":${attributes}}" >/dev/null
}

run_toxic() {
  local toxic_name="$1" toxic_type="$2" attributes="$3" duration_seconds="$4"
  bounded_integer "$duration_seconds" 1 "$MAX_DURATION_SECONDS" duration_seconds
  ensure_proxy
  clear_faults
  add_toxic "$toxic_name" "$toxic_type" downstream "$attributes"
  proxy_armed=true
  printf 'redis_fault_active=%s duration_seconds=%s proxy=%s upstream=%s change_id=%s\n' \
    "$toxic_name" "$duration_seconds" "$PROXY_NAME" "$REDIS_UPSTREAM" "$RESILIENCE_CHANGE_ID"
  sleep "$duration_seconds"
  clear_faults
  printf 'redis_fault_cleared=%s\n' "$toxic_name"
}

require_command curl
require_command kubectl
require_non_production
current_context="$(kubectl config current-context)"
[[ "$current_context" == "$EXPECTED_CONTEXT" ]] || {
  printf 'refusing context %s; expected exact non-production context %s\n' "$current_context" "$EXPECTED_CONTEXT" >&2
  exit 1
}
namespace_label="$(kubectl get namespace "$NAMESPACE" -o jsonpath='{.metadata.labels.resilience\.delivery-platform\.io/environment}' 2>/dev/null || true)"
[[ "$namespace_label" == "non-production" ]] || {
  printf 'namespace %s must have resilience.delivery-platform.io/environment=non-production\n' "$NAMESPACE" >&2
  exit 1
}

command="${1:-}"
case "$command" in
  deploy)
    kubectl -n "$NAMESPACE" apply -f "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/deploy/kubernetes/resilience-test/redis-chaos/redis-chaos.yaml"
    kubectl -n "$NAMESPACE" rollout status deployment/redis-chaos-target --timeout=120s
    kubectl -n "$NAMESPACE" rollout status deployment/redis-chaos-toxiproxy --timeout=120s
    ;;
  ensure)
    ensure_proxy
    api GET "/proxies/${PROXY_NAME}"
    ;;
  clear)
    ensure_proxy
    clear_faults
    ;;
  latency)
    latency_ms="${2:?latency requires milliseconds}"; duration_seconds="${3:?latency requires duration seconds}"; jitter_ms="${4:-0}"
    bounded_integer "$latency_ms" 1 "$MAX_LATENCY_MS" latency_ms
    bounded_integer "$jitter_ms" 0 "$MAX_JITTER_MS" jitter_ms
    run_toxic "redis-latency" latency "{\"latency\":${latency_ms},\"jitter\":${jitter_ms}}" "$duration_seconds"
    ;;
  timeout)
    timeout_ms="${2:?timeout requires milliseconds}"; duration_seconds="${3:?timeout requires duration seconds}"
    bounded_integer "$timeout_ms" 1 "$MAX_TIMEOUT_MS" timeout_ms
    run_toxic "redis-timeout" timeout "{\"timeout\":${timeout_ms}}" "$duration_seconds"
    ;;
  reset)
    delay_ms="${2:?reset requires delay milliseconds}"; duration_seconds="${3:?reset requires duration seconds}"
    bounded_integer "$delay_ms" 0 "$MAX_RESET_DELAY_MS" delay_ms
    run_toxic "redis-reset" reset_peer "{\"timeout\":${delay_ms}}" "$duration_seconds"
    ;;
  outage)
    duration_seconds="${2:?outage requires duration seconds}"
    bounded_integer "$duration_seconds" 1 "$MAX_DURATION_SECONDS" duration_seconds
    ensure_proxy
    clear_faults
    api POST "/proxies/${PROXY_NAME}" '{"enabled":false}' >/dev/null
    proxy_armed=true
    printf 'redis_fault_active=redis-outage duration_seconds=%s proxy=%s upstream=%s change_id=%s\n' \
      "$duration_seconds" "$PROXY_NAME" "$REDIS_UPSTREAM" "$RESILIENCE_CHANGE_ID"
    sleep "$duration_seconds"
    clear_faults
    printf '%s\n' 'redis_fault_cleared=redis-outage'
    ;;
  status)
    api GET "/proxies/${PROXY_NAME}"
    ;;
  *)
    cat >&2 <<EOF
Usage: $0 {deploy|ensure|clear|latency MS DURATION_SECONDS [JITTER_MS]|timeout MS DURATION_SECONDS|reset DELAY_MS DURATION_SECONDS|outage DURATION_SECONDS|status}
This controller targets only redis-chaos-target.resilience-test.svc.cluster.local through the dedicated redis-chaos-toxiproxy fixture.
Every injected fault is bounded to ${MAX_DURATION_SECONDS} seconds or less and cleanup re-enables the proxy on normal completion, interruption, or failure.
EOF
    exit 2
    ;;
esac

printf 'redis chaos command completed: %s proxy=%s upstream=%s\n' "$command" "$PROXY_NAME" "$REDIS_UPSTREAM"
