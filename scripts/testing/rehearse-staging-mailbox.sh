#!/usr/bin/env bash
set -euo pipefail

# This script is intentionally staging-only. The dedicated Mailpit instance must be
# wired as the staging notification dispatcher's email transport before execution.
: "${STAGING_LIFECYCLE_URL:?Set the staging lifecycle application URL}"
: "${STAGING_MAILPIT_API_URL:?Set the private staging Mailpit API URL}"

case "$STAGING_LIFECYCLE_URL" in
  *staging*|*stage*) ;;
  *) echo "Refusing a non-staging lifecycle URL" >&2; exit 2 ;;
esac

domain="${STAGING_TEST_EMAIL_DOMAIN:-example.test}"
case "$domain" in
  *.test|test) ;;
  *) echo "STAGING_TEST_EMAIL_DOMAIN must be a non-routable .test domain" >&2; exit 2 ;;
esac

recipient="switchos-lifecycle-$(date +%s)@${domain}"
password="${STAGING_TEST_PASSWORD:-StagingLifecyclePassword2026!}"
base="${STAGING_LIFECYCLE_URL%/}"
mailpit="${STAGING_MAILPIT_API_URL%/}"
cookie_file="$(mktemp)"
message_file="$(mktemp)"
trap 'rm -f "$cookie_file" "$message_file"' EXIT

mailpit_auth=()
if [ -n "${STAGING_MAILPIT_BASIC_AUTH:-}" ]; then
  mailpit_auth=(-u "$STAGING_MAILPIT_BASIC_AUTH")
fi

signup_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  -H 'Content-Type: application/json' \
  --data "{\"name\":\"Staging Lifecycle Verification\",\"email\":\"${recipient}\",\"password\":\"${password}\"}" \
  "${base}/api/auth/signup")"
test "$signup_status" = '202'

for _ in $(seq 1 30); do
  curl --fail --silent --show-error "${mailpit_auth[@]}" "${mailpit}/api/v1/message/latest/raw" >"$message_file" || true
  if grep -Fq "$recipient" "$message_file" && grep -qE '/verify-email\?token=[A-Za-z0-9_-]+' "$message_file"; then break; fi
  sleep 2
done

grep -Fq "$recipient" "$message_file"
token="$(grep -oE '/verify-email\?token=[A-Za-z0-9_-]+' "$message_file" | tail -1 | cut -d= -f2)"
test -n "$token"

verify_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  -c "$cookie_file" -H 'Content-Type: application/json' --data "{\"token\":\"${token}\"}" \
  "${base}/api/auth/email-verification/confirm")"
test "$verify_status" = '200'

echo "staging mailbox lifecycle rehearsal passed for an isolated .test recipient"
