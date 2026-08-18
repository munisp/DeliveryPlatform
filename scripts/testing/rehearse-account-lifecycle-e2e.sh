#!/usr/bin/env bash
set -euo pipefail

# Runs only against an isolated local service and database. It consumes the test-only
# sink output to follow an actual email-verification link, never a production mailbox.
: "${LIFECYCLE_TEST_BASE_URL:?Set the local lifecycle application URL}"
: "${LIFECYCLE_TEST_EMAIL_SINK_URL:?Set the local test email sink URL}"
: "${TEST_DATABASE_URL:?Set an isolated PostgreSQL database URL}"
: "${LIFECYCLE_TEST_EMAIL:?Set a unique test email address}"
: "${LIFECYCLE_TEST_PASSWORD:?Set a strong test password}"
: "${LIFECYCLE_TEST_INVITEE_EMAIL:?Set a unique isolated invitee email address}"
: "${LIFECYCLE_TEST_INVITEE_PASSWORD:?Set a strong isolated invitee password}"

case "$LIFECYCLE_TEST_BASE_URL $LIFECYCLE_TEST_EMAIL_SINK_URL $TEST_DATABASE_URL" in
  *production*|*prod*) echo "Refusing a production-looking lifecycle test target" >&2; exit 2 ;;
esac

cookie_file="$(mktemp)"
invitee_cookie_file="$(mktemp)"
trap 'rm -f "$cookie_file" "$invitee_cookie_file"' EXIT

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
grep -q '"redirect":"/onboarding?step=branding"' /tmp/lifecycle-organization.json

onboarding_branding_status="$(curl --silent --show-error --output /tmp/lifecycle-onboarding-branding.json --write-out '%{http_code}' \
  -b "$cookie_file" "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/onboarding")"
test "$onboarding_branding_status" = '200'
grep -q '"needsCompletion":true' /tmp/lifecycle-onboarding-branding.json

branding_status="$(curl --silent --show-error --output /tmp/lifecycle-branding.json --write-out '%{http_code}' \
  -b "$cookie_file" -H 'Content-Type: application/json' \
  --data '{"logoDataUrl":null,"primaryColor":"#2563eb","accentColor":"#172554"}' \
  "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/tenant-branding")"
test "$branding_status" = '200'
grep -q '"primaryColor":"#2563eb"' /tmp/lifecycle-branding.json

preset_status="$(curl --silent --show-error --output /tmp/lifecycle-branding-preset.json --write-out '%{http_code}' \
  -b "$cookie_file" -H 'Content-Type: application/json' \
  --data '{"name":"Lifecycle rehearsal","logoDataUrl":null,"primaryColor":"#2563eb","accentColor":"#172554"}' \
  "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/tenant-branding/presets")"
test "$preset_status" = '201'
preset_id="$(grep -oE '"id":"[^"]+"' /tmp/lifecycle-branding-preset.json | head -1 | cut -d'"' -f4)"
test -n "$preset_id"
apply_preset_status="$(curl --silent --show-error --output /tmp/lifecycle-branding-preset-applied.json --write-out '%{http_code}' \
  -b "$cookie_file" -H 'Content-Type: application/json' --data '{}' \
  "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/tenant-branding/presets/${preset_id}/apply")"
test "$apply_preset_status" = '200'
grep -q '"primaryColor":"#2563eb"' /tmp/lifecycle-branding-preset-applied.json

invitation_status="$(curl --silent --show-error --output /tmp/lifecycle-invitation.json --write-out '%{http_code}' \
  -b "$cookie_file" -H 'Content-Type: application/json' \
  --data "{\"email\":\"${LIFECYCLE_TEST_INVITEE_EMAIL}\",\"role\":\"viewer\"}" \
  "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/invitations")"
test "$invitation_status" = '202'

pending_status="$(curl --silent --show-error -b "$cookie_file" "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/invitations/status")"
printf '%s' "$pending_status" > /tmp/lifecycle-invitations-pending.json
grep -q "${LIFECYCLE_TEST_INVITEE_EMAIL}" /tmp/lifecycle-invitations-pending.json
grep -q '"status":"pending"' /tmp/lifecycle-invitations-pending.json
invitation_id="$(grep -oE '"id":"[^"]+"' /tmp/lifecycle-invitations-pending.json | head -1 | cut -d'"' -f4)"
test -n "$invitation_id"

curl --fail --silent --show-error "${LIFECYCLE_TEST_EMAIL_SINK_URL%/}/messages" >/tmp/lifecycle-messages-after-invite.json
invitation_token="$(grep -oE '/accept-invitation\?token=[A-Za-z0-9_-]+' /tmp/lifecycle-messages-after-invite.json | tail -1 | cut -d= -f2)"
test -n "$invitation_token"

resend_status="$(curl --silent --show-error --output /tmp/lifecycle-invitation-resent.json --write-out '%{http_code}' \
  -b "$cookie_file" -H 'Content-Type: application/json' --data '{}' \
  "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/invitations/${invitation_id}/resend")"
test "$resend_status" = '202'
stale_accept_status="$(curl --silent --show-error --output /tmp/lifecycle-stale-invitation.json --write-out '%{http_code}' \
  -H 'Content-Type: application/json' \
  --data "{\"token\":\"${invitation_token}\",\"name\":\"Lifecycle Test Invitee\",\"password\":\"${LIFECYCLE_TEST_INVITEE_PASSWORD}\"}" \
  "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/invitations/accept")"
test "$stale_accept_status" = '400'

pending_after_resend="$(curl --silent --show-error -b "$cookie_file" "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/invitations/status")"
printf '%s' "$pending_after_resend" >/tmp/lifecycle-invitations-after-resend.json
grep -q '"status":"revoked"' /tmp/lifecycle-invitations-after-resend.json
refreshed_invitation_id="$(grep -oE '"id":"[^"]+"' /tmp/lifecycle-invitations-after-resend.json | head -1 | cut -d'"' -f4)"
test -n "$refreshed_invitation_id"
revoke_status="$(curl --silent --show-error --output /tmp/lifecycle-invitation-revoked.json --write-out '%{http_code}' \
  -b "$cookie_file" -H 'Content-Type: application/json' --data '{}' \
  "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/invitations/${refreshed_invitation_id}/revoke")"
test "$revoke_status" = '200'

final_invitation_status="$(curl --silent --show-error --output /tmp/lifecycle-invitation-final.json --write-out '%{http_code}' \
  -b "$cookie_file" -H 'Content-Type: application/json' \
  --data "{\"email\":\"${LIFECYCLE_TEST_INVITEE_EMAIL}\",\"role\":\"viewer\"}" \
  "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/invitations")"
test "$final_invitation_status" = '202'
curl --fail --silent --show-error "${LIFECYCLE_TEST_EMAIL_SINK_URL%/}/messages" >/tmp/lifecycle-messages-after-resend.json
invitation_token="$(grep -oE '/accept-invitation\?token=[A-Za-z0-9_-]+' /tmp/lifecycle-messages-after-resend.json | tail -1 | cut -d= -f2)"
test -n "$invitation_token"

accept_status="$(curl --silent --show-error --output /tmp/lifecycle-invitation-accept.json --write-out '%{http_code}' \
  -c "$invitee_cookie_file" -H 'Content-Type: application/json' \
  --data "{\"token\":\"${invitation_token}\",\"name\":\"Lifecycle Test Invitee\",\"password\":\"${LIFECYCLE_TEST_INVITEE_PASSWORD}\"}" \
  "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/invitations/accept")"
test "$accept_status" = '200'

accepted_status="$(curl --silent --show-error -b "$cookie_file" "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/invitations/status")"
printf '%s' "$accepted_status" > /tmp/lifecycle-invitations-accepted.json
grep -q "${LIFECYCLE_TEST_INVITEE_EMAIL}" /tmp/lifecycle-invitations-accepted.json
grep -q '"status":"accepted"' /tmp/lifecycle-invitations-accepted.json

psql "$TEST_DATABASE_URL" -Atqc "
  SELECT count(*)
  FROM operator_credentials
  WHERE email = '${LIFECYCLE_TEST_EMAIL}'
    AND email_verified_at IS NOT NULL
    AND onboarding_completed_at IS NOT NULL
" | grep -qx '1'

psql "$TEST_DATABASE_URL" -Atqc "
  SELECT count(*)
  FROM account_lifecycle_tokens
  WHERE purpose = 'invitation'
    AND email = '${LIFECYCLE_TEST_INVITEE_EMAIL}'
    AND consumed_at IS NOT NULL
" | grep -qx '1'

echo "isolated account lifecycle rehearsal passed"
