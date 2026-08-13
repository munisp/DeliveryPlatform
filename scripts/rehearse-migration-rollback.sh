#!/usr/bin/env bash
set -euo pipefail

# Rehearses the reversible 0005 migration against an isolated clone. Prefer
# ROLLBACK_SNAPSHOT_FILE exported by a read-only, sanitized production-snapshot
# process; ROLLBACK_SOURCE_DATABASE_URL is only accepted for non-production
# staging sources.
: "${ROLLBACK_TARGET_DATABASE_URL:?Set ROLLBACK_TARGET_DATABASE_URL}"

for url in "${ROLLBACK_TARGET_DATABASE_URL}"; do
  case "${url}" in
    *production*|*prod*) echo "Refusing a rollback rehearsal against a production-looking URL" >&2; exit 2 ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dump="$(mktemp)"
trap 'rm -f "${tmp_dump}"' EXIT

target_tables="$(psql "${ROLLBACK_TARGET_DATABASE_URL}" -Atc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'")"
[[ "${target_tables}" == "0" ]] || { echo "Rollback target must be an empty isolated database" >&2; exit 2; }

if [[ -n "${ROLLBACK_SNAPSHOT_FILE:-}" ]]; then
  [[ -s "${ROLLBACK_SNAPSHOT_FILE}" ]] || { echo "ROLLBACK_SNAPSHOT_FILE must reference a non-empty dump" >&2; exit 2; }
  cp "${ROLLBACK_SNAPSHOT_FILE}" "${tmp_dump}"
else
  : "${ROLLBACK_SOURCE_DATABASE_URL:?Set ROLLBACK_SOURCE_DATABASE_URL or ROLLBACK_SNAPSHOT_FILE}"
  case "${ROLLBACK_SOURCE_DATABASE_URL}" in
    *production*|*prod*) echo "Use a sanitized ROLLBACK_SNAPSHOT_FILE instead of a direct production URL" >&2; exit 2 ;;
  esac
  pg_dump --no-owner --no-privileges "${ROLLBACK_SOURCE_DATABASE_URL}" > "${tmp_dump}"
fi

psql "${ROLLBACK_TARGET_DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${tmp_dump}" >/dev/null
source_users="$(psql "${ROLLBACK_TARGET_DATABASE_URL}" -Atc 'SELECT COUNT(*) FROM users')"
source_campaigns="$(psql "${ROLLBACK_TARGET_DATABASE_URL}" -Atc 'SELECT COUNT(*) FROM marketing_campaigns')"
psql "${ROLLBACK_TARGET_DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${ROOT_DIR}/drizzle/0005_users_phone_for_growth_idempotency.sql" >/dev/null
psql "${ROLLBACK_TARGET_DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${ROOT_DIR}/drizzle/rollback/0005_users_phone_for_growth_idempotency.down.sql" >/dev/null

target_users="$(psql "${ROLLBACK_TARGET_DATABASE_URL}" -Atc 'SELECT COUNT(*) FROM users')"
target_campaigns="$(psql "${ROLLBACK_TARGET_DATABASE_URL}" -Atc 'SELECT COUNT(*) FROM marketing_campaigns')"
phone_column="$(psql "${ROLLBACK_TARGET_DATABASE_URL}" -Atc "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'phone'")"

[[ "${source_users}" == "${target_users}" ]] || { echo "User count changed during clone/rollback" >&2; exit 1; }
[[ "${source_campaigns}" == "${target_campaigns}" ]] || { echo "Campaign count changed during clone/rollback" >&2; exit 1; }
[[ "${phone_column}" == "0" ]] || { echo "Rollback did not remove users.phone in the isolated target" >&2; exit 1; }

echo "PASS: isolated snapshot clone preserved users=${target_users}, campaigns=${target_campaigns}, and rolled back migration 0005"
