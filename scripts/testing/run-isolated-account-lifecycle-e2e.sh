#!/usr/bin/env bash
set -euo pipefail

# Local-only wrapper for the account lifecycle rehearsal. It owns every process
# it starts and removes the disposable database on every exit path.
: "${LIFECYCLE_TEST_DB_NAME:=lifecycle_e2e_$RANDOM}"
: "${LIFECYCLE_TEST_APP_PORT:=3130}"
: "${LIFECYCLE_TEST_SINK_PORT:=3131}"

case "$LIFECYCLE_TEST_DB_NAME" in
  lifecycle_e2e_[a-z0-9_]*|lifecycle_e2e_[0-9]*) ;;
  *) echo "Refusing non-disposable lifecycle database name" >&2; exit 2 ;;
esac

for command in setsid curl psql sudo; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 2; }
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
token="$(od -An -N20 -tx1 /dev/urandom | tr -d ' \n')"
role_suffix="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
LIFECYCLE_TEST_DB_ROLE="lifecycle_e2e_${role_suffix}"
db_password="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
db_url="postgresql://${LIFECYCLE_TEST_DB_ROLE}:${db_password}@127.0.0.1:5432/${LIFECYCLE_TEST_DB_NAME}?sslmode=disable"
app_group=""
sink_group=""
database_created=false
role_created=false

port_is_occupied() {
  local sockets
  sockets="$(ss -ltn "sport = :$1" 2>/dev/null || true)"
  grep -q LISTEN <<<"$sockets"
}

terminate_tree() {
  local parent="$1"
  local child
  for child in $(pgrep -P "$parent" 2>/dev/null || true); do
    terminate_tree "$child"
  done
  kill "$parent" 2>/dev/null || true
}

cleanup() {
  set +e
  [ -n "$app_group" ] && terminate_tree "$app_group"
  [ -n "$sink_group" ] && terminate_tree "$sink_group"
  [ -n "$app_group" ] && wait "$app_group" 2>/dev/null
  [ -n "$sink_group" ] && wait "$sink_group" 2>/dev/null
  if [ "$database_created" = true ]; then
    sudo -u postgres dropdb --if-exists --force "$LIFECYCLE_TEST_DB_NAME" >/dev/null 2>&1
  fi
  if [ "$role_created" = true ]; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${LIFECYCLE_TEST_DB_ROLE}" >/dev/null 2>&1
  fi
}
trap cleanup EXIT INT TERM

sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE ${LIFECYCLE_TEST_DB_ROLE} LOGIN PASSWORD '${db_password}'" >/dev/null
role_created=true
sudo -u postgres dropdb --if-exists --force "$LIFECYCLE_TEST_DB_NAME" >/dev/null 2>&1 || true
sudo -u postgres createdb -O "$LIFECYCLE_TEST_DB_ROLE" "$LIFECYCLE_TEST_DB_NAME"
database_created=true

cd "$repo_root"
if port_is_occupied "$LIFECYCLE_TEST_APP_PORT" || port_is_occupied "$LIFECYCLE_TEST_SINK_PORT"; then
  echo "Refusing occupied isolated lifecycle rehearsal port" >&2
  exit 2
fi

env NODE_ENV=test TEST_EMAIL_SINK_PORT="$LIFECYCLE_TEST_SINK_PORT" TEST_INTERNAL_TOKEN="$token" \
  node scripts/testing/lifecycle-email-sink.mjs >/tmp/lifecycle-isolated-sink.log 2>&1 &
sink_group=$!

env NODE_ENV=test PORT="$LIFECYCLE_TEST_APP_PORT" DATABASE_URL="$db_url" \
  INTERNAL_SERVICE_TOKEN="$token" NOTIFICATION_DISPATCHER_URL="http://127.0.0.1:${LIFECYCLE_TEST_SINK_PORT}" \
  ENABLE_SELF_SERVICE_SIGNUP=true PUBLIC_APP_ORIGIN="http://127.0.0.1:${LIFECYCLE_TEST_APP_PORT}" \
  pnpm exec tsx server/_core/index.ts >/tmp/lifecycle-isolated-app.log 2>&1 &
app_group=$!

for attempt in $(seq 1 40); do
  if curl --silent --fail "http://127.0.0.1:${LIFECYCLE_TEST_APP_PORT}/api/auth/config" >/dev/null; then
    break
  fi
  sleep 1
done
curl --silent --fail "http://127.0.0.1:${LIFECYCLE_TEST_APP_PORT}/api/auth/config" >/dev/null

timestamp="$(date +%s)"
LIFECYCLE_TEST_BASE_URL="http://127.0.0.1:${LIFECYCLE_TEST_APP_PORT}" \
LIFECYCLE_TEST_EMAIL_SINK_URL="http://127.0.0.1:${LIFECYCLE_TEST_SINK_PORT}" \
TEST_DATABASE_URL="$db_url" \
LIFECYCLE_TEST_EMAIL="lifecycle-e2e-${timestamp}@example.test" \
LIFECYCLE_TEST_PASSWORD='ChangeMe!9Test' \
LIFECYCLE_TEST_INVITEE_EMAIL="lifecycle-invite-${timestamp}@example.test" \
LIFECYCLE_TEST_INVITEE_PASSWORD='ChangeMe!8Invite' \
bash scripts/testing/rehearse-account-lifecycle-e2e.sh

printf '%s\n' "isolated account lifecycle rehearsal passed"
