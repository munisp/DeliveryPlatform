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
share_preset_status="$(curl --silent --show-error --output /tmp/lifecycle-branding-preset-shared.json --write-out '%{http_code}' \
  -b "$cookie_file" -H 'Content-Type: application/json' --data '{"shared":true}' \
  "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/tenant-branding/presets/${preset_id}/share")"
test "$share_preset_status" = '200'
grep -q '"organizationShared":true' /tmp/lifecycle-branding-preset-shared.json
psql "$TEST_DATABASE_URL" -Atqc "SELECT count(*) FROM tenant_branding_presets WHERE id = '${preset_id}' AND organization_shared = TRUE" | grep -qx '1'

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

bulk_invitee_one="bulk-one-${LIFECYCLE_TEST_INVITEE_EMAIL}"
bulk_invitee_two="bulk-two-${LIFECYCLE_TEST_INVITEE_EMAIL}"
for bulk_email in "$bulk_invitee_one" "$bulk_invitee_two"; do
  bulk_invitation_status="$(curl --silent --show-error --output /tmp/lifecycle-bulk-invitation.json --write-out '%{http_code}' \
    -b "$cookie_file" -H 'Content-Type: application/json' \
    --data "{\"email\":\"${bulk_email}\",\"role\":\"viewer\"}" \
    "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/invitations")"
  test "$bulk_invitation_status" = '202'
done
bulk_pending_status="$(curl --silent --show-error -b "$cookie_file" "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/invitations/status")"
printf '%s' "$bulk_pending_status" >/tmp/lifecycle-invitations-bulk-pending.json
bulk_invitation_ids="$(grep -oE '"id":"[^"]+"' /tmp/lifecycle-invitations-bulk-pending.json | head -2 | cut -d'"' -f4 | paste -sd ',' -)"
test -n "$bulk_invitation_ids"
bulk_resend_status="$(curl --silent --show-error --output /tmp/lifecycle-invitations-bulk-resent.json --write-out '%{http_code}' \
  -b "$cookie_file" -H 'Content-Type: application/json' \
  --data "{\"invitationIds\":[\"${bulk_invitation_ids/,/\",\"}\"]}" \
  "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/invitations/actions/bulk/resend")"
test "$bulk_resend_status" = '202'
grep -q '"failed":\[\]' /tmp/lifecycle-invitations-bulk-resent.json
bulk_refreshed_status="$(curl --silent --show-error -b "$cookie_file" "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/invitations/status")"
printf '%s' "$bulk_refreshed_status" >/tmp/lifecycle-invitations-bulk-refreshed.json
bulk_refreshed_ids="$(grep -oE '"id":"[^"]+"' /tmp/lifecycle-invitations-bulk-refreshed.json | head -2 | cut -d'"' -f4 | paste -sd ',' -)"
test -n "$bulk_refreshed_ids"
bulk_revoke_status="$(curl --silent --show-error --output /tmp/lifecycle-invitations-bulk-revoked.json --write-out '%{http_code}' \
  -b "$cookie_file" -H 'Content-Type: application/json' \
  --data "{\"invitationIds\":[\"${bulk_refreshed_ids/,/\",\"}\"]}" \
  "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/invitations/actions/bulk/revoke")"
test "$bulk_revoke_status" = '200'
grep -q '"failed":\[\]' /tmp/lifecycle-invitations-bulk-revoked.json
psql "$TEST_DATABASE_URL" -Atqc "SELECT count(*) FROM account_lifecycle_tokens WHERE purpose = 'invitation' AND email IN ('${bulk_invitee_one}', '${bulk_invitee_two}') AND revoked_at IS NOT NULL" | grep -qx '4'

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

invitee_operator_id="$(psql "$TEST_DATABASE_URL" -Atqc "SELECT id FROM operator_credentials WHERE email = '${LIFECYCLE_TEST_INVITEE_EMAIL}'")"
test -n "$invitee_operator_id"
bulk_role_status="$(curl --silent --show-error --output /tmp/lifecycle-members-role.json --write-out '%{http_code}' \
  -b "$cookie_file" -H 'Content-Type: application/json' \
  --data "{\"memberIds\":[${invitee_operator_id}],\"role\":\"admin\"}" \
  "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/members/actions/bulk/role")"
test "$bulk_role_status" = '200'
grep -q '"changed":1' /tmp/lifecycle-members-role.json

transfer_status="$(curl --silent --show-error --output /tmp/lifecycle-preset-transfer.json --write-out '%{http_code}' \
  -b "$cookie_file" -H 'Content-Type: application/json' \
  --data "{\"recipientEmail\":\"${LIFECYCLE_TEST_INVITEE_EMAIL}\"}" \
  "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/tenant-branding/presets/${preset_id}/transfer-ownership")"
test "$transfer_status" = '200'
psql "$TEST_DATABASE_URL" -Atqc "SELECT count(*) FROM tenant_branding_presets WHERE id = '${preset_id}' AND created_by_operator_id = ${invitee_operator_id} AND ownership_transferred_at IS NOT NULL" | grep -qx '1'

csv_status="$(curl --silent --show-error --output /tmp/lifecycle-invitation-activity.csv --write-out '%{http_code}' -b "$cookie_file" "${LIFECYCLE_TEST_BASE_URL%/}/api/auth/invitations/activity.csv")"
test "$csv_status" = '200'
grep -q '"invitation_id","recipient_email","role","status"' /tmp/lifecycle-invitation-activity.csv
grep -q "${LIFECYCLE_TEST_INVITEE_EMAIL}" /tmp/lifecycle-invitation-activity.csv

echo "isolated account lifecycle rehearsal passed"
