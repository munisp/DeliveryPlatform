#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   SWITCHOS_PUBLIC_HOST=switchos.example.com \
#   SWITCHOS_AUTH_HOST=auth.example.com \
#   ./scripts/verify-staging-edge.sh
#
# The Caddy deployment must already be running. The verifier intentionally
# fails if it cannot prove TLS, Keycloak discovery, Caddy health routing, or
# a WAF block response from the configured public edge.

PUBLIC_HOST="${SWITCHOS_PUBLIC_HOST:-localhost}"
AUTH_HOST="${SWITCHOS_AUTH_HOST:-auth.localhost}"
PUBLIC_URL="https://${PUBLIC_HOST}"
AUTH_URL="https://${AUTH_HOST}"
WAF_ALLOWED_BLOCK_CODES="${WAF_ALLOWED_BLOCK_CODES:-403|406|429}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 2
  }
}

assert_status() {
  local description="$1"
  local expected_pattern="$2"
  shift 2
  local status
  status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$@")"
  if [[ ! "$status" =~ ^(${expected_pattern})$ ]]; then
    echo "FAILED: ${description}; expected ${expected_pattern}, received ${status}" >&2
    exit 1
  fi
  echo "PASS: ${description} (${status})"
}

require_command curl

assert_status "Caddy health endpoint over TLS" "200" --fail --connect-timeout 10 "${PUBLIC_URL}/healthz"
assert_status "HTTP to HTTPS edge redirect" "301|302|307|308" --connect-timeout 10 --max-redirs 0 "http://${PUBLIC_HOST}/healthz"
assert_status "Keycloak OIDC discovery through Caddy" "200" --fail --connect-timeout 10 "${AUTH_URL}/realms/switchos/.well-known/openid-configuration"

# This probe uses a deliberately suspicious query parameter and a known
# automation user agent. It must be blocked by the attached Open AppSec
# enforcement point rather than reaching APISIX or application upstreams.
assert_status \
  "Open AppSec blocks a suspicious public-edge probe" \
  "${WAF_ALLOWED_BLOCK_CODES}" \
  --connect-timeout 10 \
  --user-agent "sqlmap/1.8-staging-verifier" \
  "${PUBLIC_URL}/healthz?probe=%27%20OR%201%3D1--"

echo "All live staging edge checks passed."
