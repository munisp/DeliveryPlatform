#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${RESILIENCE_TEST_NAMESPACE:-resilience-test}"
EXPECTED_CONTEXT="${RESILIENCE_TEST_CONTEXT:?RESILIENCE_TEST_CONTEXT must name the exact non-production kubectl context}"
TARGET_ENV="${TARGET_ENV:-staging}"
TOXIPROXY_API_URL="${TOXIPROXY_API_URL:-http://payment-provider-toxiproxy.${NAMESPACE}.svc.cluster.local:8474}"
PROXY_NAME="${TOXIPROXY_PROXY_NAME:-payment-provider}"
PROXY_LISTEN="${TOXIPROXY_PROXY_LISTEN:-0.0.0.0:8666}"
PROVIDER_SIMULATOR_UPSTREAM="${PROVIDER_SIMULATOR_UPSTREAM:?PROVIDER_SIMULATOR_UPSTREAM must be a test-only host:port, such as provider-simulator.resilience-test.svc.cluster.local:8080}"
FAULT_NAME_PREFIX="${FAULT_NAME_PREFIX:-resilience-payment}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || { printf 'missing required command: %s\n' "$1" >&2; exit 1; }
}

require_non_production() {
  [[ "${CONFIRM_NON_PRODUCTION_GATEWAY_FAULTS:-}" == "run" ]] || {
    printf 'set CONFIRM_NON_PRODUCTION_GATEWAY_FAULTS=run to enable a test-only provider simulator fault\n' >&2
    exit 1
  }
  [[ "$TARGET_ENV" == "test" || "$TARGET_ENV" == "staging" || "$TARGET_ENV" == "preproduction" ]] || {
    printf 'TARGET_ENV must be test, staging, or preproduction\n' >&2
    exit 1
  }
  [[ ! "$PROVIDER_SIMULATOR_UPSTREAM" =~ (^|[.-])(prod|production)([.-]|$) ]] || {
    printf 'refusing production-like provider upstream: %s\n' "$PROVIDER_SIMULATOR_UPSTREAM" >&2
    exit 1
  }
  [[ "$PROVIDER_SIMULATOR_UPSTREAM" =~ ^[A-Za-z0-9.-]+:[1-9][0-9]*$ ]] || {
    printf 'PROVIDER_SIMULATOR_UPSTREAM must be a DNS host and port; URLs and IP literals are refused\n' >&2
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
    api POST /proxies "{\"name\":\"${PROXY_NAME}\",\"listen\":\"${PROXY_LISTEN}\",\"upstream\":\"${PROVIDER_SIMULATOR_UPSTREAM}\",\"enabled\":true}" >/dev/null
  fi
  api POST "/proxies/${PROXY_NAME}" '{"enabled":true}' >/dev/null
}

clear_faults() {
  api DELETE "/proxies/${PROXY_NAME}/toxics" >/dev/null || true
  api POST "/proxies/${PROXY_NAME}" '{"enabled":true}' >/dev/null
}

add_toxic() {
  local name="$1" type="$2" stream="$3" attributes="$4"
  api POST "/proxies/${PROXY_NAME}/toxics" "{\"name\":\"${name}\",\"type\":\"${type}\",\"stream\":\"${stream}\",\"toxicity\":1.0,\"attributes\":${attributes}}" >/dev/null
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
    kubectl -n "$NAMESPACE" apply -f "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/deploy/kubernetes/resilience-test/toxiproxy/toxiproxy.yaml"
    kubectl -n "$NAMESPACE" rollout status deployment/payment-provider-toxiproxy --timeout=120s
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
    ensure_proxy
    clear_faults
    latency_ms="${2:?latency command requires milliseconds}"; jitter_ms="${3:-0}"
    [[ "$latency_ms" =~ ^[0-9]+$ && "$jitter_ms" =~ ^[0-9]+$ ]] || { printf 'latency and jitter must be non-negative integers\n' >&2; exit 1; }
    add_toxic "${FAULT_NAME_PREFIX}-latency" latency downstream "{\"latency\":${latency_ms},\"jitter\":${jitter_ms}}"
    ;;
  timeout)
    ensure_proxy
    clear_faults
    timeout_ms="${2:?timeout command requires milliseconds}"
    [[ "$timeout_ms" =~ ^[0-9]+$ ]] || { printf 'timeout must be a non-negative integer\n' >&2; exit 1; }
    add_toxic "${FAULT_NAME_PREFIX}-timeout" timeout downstream "{\"timeout\":${timeout_ms}}"
    ;;
  reset)
    ensure_proxy
    clear_faults
    delay_ms="${2:-0}"
    [[ "$delay_ms" =~ ^[0-9]+$ ]] || { printf 'reset delay must be a non-negative integer\n' >&2; exit 1; }
    add_toxic "${FAULT_NAME_PREFIX}-reset" reset_peer downstream "{\"timeout\":${delay_ms}}"
    ;;
  bandwidth)
    ensure_proxy
    clear_faults
    rate_kb="${2:?bandwidth command requires KB/s}"
    [[ "$rate_kb" =~ ^[1-9][0-9]*$ ]] || { printf 'bandwidth rate must be a positive integer KB/s\n' >&2; exit 1; }
    add_toxic "${FAULT_NAME_PREFIX}-bandwidth" bandwidth downstream "{\"rate\":${rate_kb}}"
    ;;
  loss)
    ensure_proxy
    clear_faults
    loss_rate="${2:?loss command requires decimal loss rate from 0 through 1}"; correlation="${3:-0}"
    [[ "$loss_rate" =~ ^(0|0\.[0-9]+|1|1\.0+)$ && "$correlation" =~ ^(0|0\.[0-9]+|1|1\.0+)$ ]] || { printf 'loss rate and correlation must be decimal values from 0 through 1\n' >&2; exit 1; }
    add_toxic "${FAULT_NAME_PREFIX}-loss" packet_loss downstream "{\"loss_rate\":${loss_rate},\"correlation\":${correlation}}"
    ;;
  down)
    ensure_proxy
    clear_faults
    api POST "/proxies/${PROXY_NAME}" '{"enabled":false}' >/dev/null
    ;;
  status)
    api GET "/proxies/${PROXY_NAME}"
    ;;
  *)
    cat >&2 <<EOF
Usage: $0 {deploy|ensure|clear|latency MS [JITTER_MS]|timeout MS|reset [DELAY_MS]|bandwidth KBPS|loss RATE [CORRELATION]|down|status}

This tool injects faults only between a payment worker and a dedicated test provider simulator.
It refuses production-like upstreams, unlabelled namespaces, mismatched kubectl contexts, and missing explicit confirmation.
After every experiment, run '$0 clear' and verify queue drain plus PostgreSQL financial invariant probes.
EOF
    exit 2
    ;;
esac

printf 'fault command completed: %s proxy=%s upstream=%s\n' "$command" "$PROXY_NAME" "$PROVIDER_SIMULATOR_UPSTREAM"
