# Account Lifecycle Runbook

## Implemented flow

The platform now supports a managed account lifecycle for operator access. A self-service registration creates an inactive administrator account, stores only a SHA-256 hash of an opaque verification token, and dispatches a verification email through the configured internal notification service. Confirming that single-use, expiring token activates the account and creates a signed session. The verified administrator then completes organization and tenant creation, becoming the first tenant administrator.

| User journey | Web route | Server endpoint | Security boundary |
|---|---|---|---|
| Self-service signup | `/signup` | `POST /api/auth/signup` | Disabled unless explicitly enabled; password policy, rate limit, inactive account until verification. |
| Email verification | `/verify-email?token=…` | `POST /api/auth/email-verification/confirm` | Opaque 256-bit token, SHA-256 storage hash, single use, expiry, session issued only after activation. |
| Resend verification | Portal recovery path | `POST /api/auth/email-verification/resend` | Generic response avoids account enumeration. |
| Password reset | `/reset-password` | `POST /api/auth/password-reset/request` and `/confirm` | Generic request response; separate short-lived, single-use token; password policy enforced. |
| Team invitation | `/team/invite` | `POST /api/auth/invitations` | Authenticated tenant administrators only; invitation is bound to email, tenant, organization, and role. |
| Invitation acceptance | `/accept-invitation?token=…` | `POST /api/auth/invitations/accept` | Blocks cross-tenant account reassignment; sets verified active credentials and membership atomically. |
| Organization onboarding | `/onboarding` | `GET /api/auth/onboarding`, `POST /api/auth/onboarding/organization` | Requires an authenticated, verified active operator; creates organization, tenant, membership, and refreshed tenant session in one transaction. |

External OIDC identities are provisioned into the same operator lifecycle store on successful callback. They are marked email-verified because the configured identity provider has already asserted the email claim, then follow the same organization setup path when no tenant claim exists.

## Required production configuration

The account lifecycle is intentionally disabled by default. To enable self-service registration, configure the following values in the production secret manager and apply the database migration before starting the application.

| Variable | Required when | Purpose |
|---|---|---|
| `ENABLE_SELF_SERVICE_SIGNUP=true` | Enabling public signup | Explicitly enables signup; defaults to `false`. |
| `PUBLIC_APP_ORIGIN=https://app.example.com` | Always in production | Trusted origin used to construct verification, reset, and invitation links. |
| `NOTIFICATION_DISPATCHER_URL=https://…` | When self-service signup is enabled | Internal transactional-notification endpoint. The app fails at startup if it is missing in this mode. |
| `INTERNAL_SERVICE_TOKEN=<rotated secret>` | Always in production | Authenticates lifecycle email dispatch to the notification service. |
| `LIFECYCLE_VERIFICATION_TTL_MINUTES` | Optional | Verification lifetime; default 1,440 minutes. |
| `LIFECYCLE_PASSWORD_RESET_TTL_MINUTES` | Optional | Reset lifetime; default 60 minutes. |
| `LIFECYCLE_INVITATION_TTL_MINUTES` | Optional | Invitation lifetime; default 10,080 minutes. |

The notification service must accept `POST /dispatch` with the existing internal service-token contract and render `generic_email` messages. It must deliver the supplied subject and body without logging the full lifecycle URL or opaque token. The application fails the initiating signup or invitation request if the dispatcher does not accept delivery; it never reports a false email success.

## Migration and rollback

Apply `drizzle/0008_account_lifecycle.sql` through the controlled database migration pipeline before deploying application code. In production, the application checks that all lifecycle tables and both operator lifecycle columns exist; it refuses lifecycle requests if the migration contract is absent.

`drizzle/rollback/0008_account_lifecycle.down.sql` is provided only for an isolated rollback rehearsal. It removes lifecycle accounts' supporting data and should not be used on a live system without an approved data-retention and customer-notification plan.

## Local email-delivery rehearsal

`scripts/testing/lifecycle-email-sink.mjs` is a **test-only** local dispatcher. It requires `NODE_ENV=test` and a strong `TEST_INTERNAL_TOKEN`, verifies the same internal token header used by the application, and retains messages only in memory at its local `/messages` endpoint. It is not included in the production application path.

After starting that sink and an application instance pointed at an isolated database, run `scripts/testing/rehearse-account-lifecycle-e2e.sh`. The script rejects production-looking URLs, follows the emitted verification link from the local sink, creates an organization and tenant using the issued session, saves validated tenant branding, accepts a tenant-scoped invitation, confirms pending-to-accepted invitation tracking, and checks durable verified/onboarded state in PostgreSQL.

## Staging mailbox rehearsal

`deploy/testing/docker-compose.staging-mailbox.yml` defines a **staging-only** Mailpit v1.30.5 capture service. Its web/API interface binds to loopback and its SMTP listener is not published to the host. Configure the staging notification dispatcher to send its email channel into that private Mailpit SMTP listener; do not point this service to a public relay or a customer mailbox.

Once the staging lifecycle application and private Mailpit API URL are available, run `scripts/testing/rehearse-staging-mailbox.sh`. The rehearsal refuses URLs that do not identify a staging environment and creates a unique recipient in a non-routable `.test` domain. It checks the raw captured email for the secure verification link, calls the staged verification endpoint, and deletes the locally retained raw message at exit. Mailpit’s REST API and optional Basic Authentication are documented by the project itself.[1]

[1]: https://mailpit.axllent.org/docs/api-v1/ "Mailpit API v1 documentation"

## Evidence and limitations

The implementation has passed the lifecycle migration/configuration regressions, production environment security tests, the complete repository suite (**155 passed, 30 environment-gated skipped**), TypeScript checking, production build, and a visual signup-screen review. The unconfigured email dispatcher and production identity provider were not invoked from this development environment; production enablement therefore requires a controlled integration test that proves a real transactional email reaches a test mailbox and that the configured identity provider sends an asserted email claim.
