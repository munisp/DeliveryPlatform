#!/usr/bin/env bash
set -euo pipefail

# Runs only against an isolated local service and database. It consumes the test-only
# sink output to follow an actual email-verification link, never a production mailbox.
: "${LIFECYCLE_TEST_BASE_URL:?Set the local lifecycle application URL}"
: "${LIFECYCLE_TEST_EMAIL_SINK_URL:?Set the local test email sink URL}"
: "${TEST_DATABASE_URL:?Set an isolated PostgreSQL database URL}"
: "${LIFECYCLE_TEST_EMAIL:?Set a unique test email address}"
: "${LIFECYCLE_TEST_PASSWORD:?Set a strong test password}"

case "$LIFECYCLE_TEST_BASE_URL $LIFECYCLE_TEST_EMAIL_SINK_URL $TEST_DATABASE_URL" in
  *production*|*prod*) echo "Refusing a production-looking lifecycle test target" >&2; exit 2 ;;
esac

cookie_file="$(mktemp)"
trap 'rm -f "$cookie_file"' EXIT

signup_status="$(curl --silent --show-error --output /tmp/lifecycle-signup.json --write-out '%{http_code}' \
  -H 'Content-Type: application/json' \
  --data "{\"name\":\"Lifecycle Test Administrator\",\"email\":\"${LIFECYCLE_TEST_EMAIL}\",\"password\":\"${LIFECYCLE_TEST_PASSWORD}\"}" \
  "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/signup")"
test "$signup_status" = '202'
grep -q '"verificationDispatched":true' /tmp/lifecycle-signup.json

curl --fail --silent --show-error "${LIFECYCLE_TEST_EMAIL_SINK_URL%/}/messages" >/tmp/lifecycle-messages.json
token="$(grep -oE 'token=[A-Za-z0-9_-]+' /tmp/lifecycle-messages.json | tail -1 | cut -d= -f2)"
test -n "$token"

verify_status="$(curl --silent --show-error --output /tmp/lifecycle-verify.json --write-out '%{http_code}' \
  -c "$cookie_file" -H 'Content-Type: application/json' \
  --data "{\"token\":\"${token}\"}" \
  "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/email-verification/confirm")"
test "$verify_status" = '200'

onboarding_status="$(curl --silent --show-error --output /tmp/lifecycle-onboarding-before.json --write-out '%{http_code}' \
  -b "$cookie_file" "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/onboarding")"
test "$onboarding_status" = '200'
grep -q '"needsOrganization":true' /tmp/lifecycle-onboarding-before.json

slug="lifecycle-e2e-$(date +%s)"
organization_status="$(curl --silent --show-error --output /tmp/lifecycle-organization.json --write-out '%{http_code}' \
  -b "$cookie_file" -c "$cookie_file" -H 'Content-Type: application/json' \
  --data "{\"organizationName\":\"Lifecycle Test Organization\",\"organizationSlug\":\"${slug}\",\"tenantName\":\"Lifecycle Test Tenant\"}" \
  "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/onboarding/organization")"
test "$organization_status" = '201'
grep -q '"redirect":"/dashboard"' /tmp/lifecycle-organization.json

psql "$TEST_DATABASE_URL" -Atqc "
  SELECT count(*)
  FROM operator_credentials
  WHERE email = '${LIFECYCLE_TEST_EMAIL}'
    AND email_verified_at IS NOT NULL
    AND onboarding_completed_at IS NOT NULL
" | grep -qx '1'

echo "isolated account lifecycle rehearsal passed"
