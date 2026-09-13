#!/usr/bin/env bash
set -euo pipefail

if [[ "${ALLOW_LOCAL_CONTAINERIZED_CI:-}" != "I_UNDERSTAND_THIS_CREATES_A_DISPOSABLE_LOCAL_POSTGIS_DATABASE" ]]; then
  echo "Refusing local CI: set ALLOW_LOCAL_CONTAINERIZED_CI=I_UNDERSTAND_THIS_CREATES_A_DISPOSABLE_LOCAL_POSTGIS_DATABASE" >&2
  exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$root/deploy/testing/docker-compose.local-ci.yml"
project="switchos_local_ci_${RANDOM}_$$"
password="$(openssl rand -hex 24)"
compose=()

cleanup() {
  if [[ ${#compose[@]} -gt 0 ]]; then
    "${compose[@]}" --project-name "$project" --file "$compose_file" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

export LOCAL_CI_POSTGRES_PASSWORD="$password"

if docker compose version >/dev/null 2>&1; then
  compose=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose=(docker-compose)
else
  echo "Refusing local CI: install Docker Compose v2 (docker compose) or docker-compose" >&2
  exit 2
fi

# This runner creates only a disposable local PostGIS service and ephemeral CI
# containers. It does not publish images, invoke Kubernetes, or contact payment,
# tracker, or deployment endpoints.
"${compose[@]}" --project-name "$project" --file "$compose_file" up --build -d postgres

for attempt in $(seq 1 30); do
  if "${compose[@]}" --project-name "$project" --file "$compose_file" exec -T postgres pg_isready -U local_ci -d local_ci >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == "30" ]]; then
    echo "Local CI PostgreSQL service did not become ready" >&2
    exit 1
  fi
  sleep 1
done

for service in migrate-tracking node-check python-check go-check node-postgres-integration; do
  "${compose[@]}" --project-name "$project" --file "$compose_file" run --rm --no-deps "$service"
done

echo "local_containerized_ci=PASS project=$project"
