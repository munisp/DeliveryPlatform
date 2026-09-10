#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ACKNOWLEDGMENT="I_UNDERSTAND_THIS_USES_A_DISPOSABLE_LOCAL_POSTGIS_DATABASE"

if [[ "${RUN_ROLE_SCOPED_TRACKING_LIVE_INTEGRATION:-}" != "$ACKNOWLEDGMENT" ]]; then
  echo "Refusing to run. Set RUN_ROLE_SCOPED_TRACKING_LIVE_INTEGRATION=$ACKNOWLEDGMENT" >&2
  exit 64
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required and must reference a disposable local PostgreSQL/PostGIS database." >&2
  exit 64
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required to apply the disposable fixture and migrations." >&2
  exit 69
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/tests/fixtures/role_scoped_tracking_snapshot_fixture.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/drizzle/0066_realtime_tracking_offline_sync_tenant_api.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/drizzle/0068_role_scoped_tracking_snapshot.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/drizzle/0069_realtime_tracking_delta_notifications.sql"
RUN_ROLE_SCOPED_TRACKING_LIVE_INTEGRATION="$ACKNOWLEDGMENT" \
  pnpm --dir "$ROOT_DIR" exec vitest run tests/role-scoped-tracking-live.integration.test.ts
