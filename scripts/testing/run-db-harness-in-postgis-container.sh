#!/usr/bin/env bash
set -euo pipefail

# Runs one existing disposable PostgreSQL/PostGIS harness in a fresh isolated
# container. It never publishes a port, mounts no database data, and removes the
# container after the harness exits. The temporary sudo shim only translates the
# harness's `sudo -u postgres psql|createdb|dropdb` calls to docker exec.

usage() {
  cat <<'USAGE'
Usage: run-db-harness-in-postgis-container.sh --harness PATH [--image IMAGE]

PATH must be a repository-relative executable harness that uses only
`sudo -u postgres psql`, `createdb`, and `dropdb` for its disposable database.
The default image is postgis/postgis:16-3.4.
USAGE
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS=""
IMAGE="${POSTGIS_TEST_IMAGE:-postgis/postgis:16-3.4}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --harness) HARNESS="${2:-}"; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

if [ -z "$HARNESS" ] || [[ "$HARNESS" = /* ]] || [[ "$HARNESS" == *".."* ]]; then
  echo "a repository-relative --harness path is required" >&2
  exit 64
fi
HARNESS_PATH="$ROOT_DIR/$HARNESS"
if [ ! -x "$HARNESS_PATH" ]; then
  echo "harness is not executable: $HARNESS" >&2
  exit 66
fi

DOCKER_BIN="$(command -v docker || true)"
if [ -z "$DOCKER_BIN" ]; then
  echo "docker is required for container-mode validation" >&2
  exit 69
fi

RUN_ID="${CI_DB_HARNESS_RUN_ID:-ci-db-${RANDOM}-${RANDOM}}"
CONTAINER="deliveryplatform-${RUN_ID//[^a-zA-Z0-9_.-]/-}"
SHIM_DIR="$(mktemp -d)"
cleanup() {
  set +e
  "$DOCKER_BIN" rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$SHIM_DIR"
}
trap cleanup EXIT

"$DOCKER_BIN" run -d --rm --name "$CONTAINER" \
  --read-only=false \
  -e POSTGRES_DB=postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=disposable-postgres-only \
  "$IMAGE" >/dev/null

ready=0
for _ in $(seq 1 60); do
  if "$DOCKER_BIN" exec "$CONTAINER" psql -U postgres -d postgres -Atqc 'SELECT 1' 2>/dev/null | grep -qx 1; then
    ready=$((ready + 1))
    if [ "$ready" -ge 2 ]; then break; fi
  else
    ready=0
  fi
  sleep 1
done
if [ "$ready" -lt 2 ]; then
  "$DOCKER_BIN" logs "$CONTAINER" >&2 || true
  echo "PostGIS container did not become ready" >&2
  exit 75
fi

cat > "$SHIM_DIR/sudo" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" != "-u" ] || [ "${2:-}" != "postgres" ]; then
  echo "container validation shim only permits: sudo -u postgres ..." >&2
  exit 77
fi
shift 2
case "${1:-}" in
  psql|createdb|dropdb)
    command="$1"
    shift
    exec "$DELIVERYPLATFORM_DOCKER_BIN" exec -i "$DELIVERYPLATFORM_POSTGIS_CONTAINER" "$command" -U postgres "$@"
    ;;
  *)
    echo "container validation shim rejects postgres command: ${1:-}" >&2
    exit 77
    ;;
esac
SHIM
chmod 0700 "$SHIM_DIR/sudo"

printf 'ci_database_harness=%s container=%s image=%s\n' "$HARNESS" "$CONTAINER" "$IMAGE"
PATH="$SHIM_DIR:$PATH" \
  DELIVERYPLATFORM_DOCKER_BIN="$DOCKER_BIN" \
  DELIVERYPLATFORM_POSTGIS_CONTAINER="$CONTAINER" \
  "$HARNESS_PATH"
