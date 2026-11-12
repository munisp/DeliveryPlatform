# Unilag Campus Pilot Runbook (P5-PILOT)

Launch runbook for the University of Lagos (Akoka) campus pilot: growth-engine
promotion (referrals / loyalty / campaigns), pilot cohort seeding, smoke tests
and rollback. All steps are idempotent and safe to re-run.

## 1. Environment checklist

| Variable | Why | Reference |
| --- | --- | --- |
| `DATABASE_URL` | Postgres target for migrations, seed and the server pool | `.env.example:23` |
| `NODE_ENV` / `PORT` | Runtime mode / bind port | `.env.example:11-12` |
| `REDIS_URL` | Rate limiting / policy cache | `.env.example:29` |
| `REQUIRE_MFA_FOR_PRIVILEGED_ACTIONS` | Must be `true` in pilot; gates `growth.createCampaign` / `updateCampaign` / `leaderboardSummary` (`operatorMutationProcedure("operate")`) | `.env.example:51` |
| `PERMIFY_ENDPOINT` / `PERMIFY_AUTH_TOKEN` / `PERMIFY_DEPTH` | Workspace policy engine for the operator lane (scope fallback applies when unset) | `.env.example:141-143` |
| `RIDE_MATCHING_WORKER_URL` | Ride-matching worker for consumer ride requests on campus zones (P3) | `.env.example:102` |
| `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_APP_SECRET` / `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Cloud API webhook + send credentials for referral/campaign messaging (P1/P2) | `.env.example:247-250` |
| `POWERSYNC_SERVICE_URL` / `POWERSYNC_JWT_*` | PowerSync replica path; 0105 publishes the growth tables | `.env.example:68-76` |
| `PILOT_SEED` | Seed gate — must be `1` to execute `scripts/seed/pilot_unilag.ts` | this doc §3 |

## 2. Database migration

`drizzle/0105_growth_tables_promotion.sql` is the lead-approved migration
exception that promotes the growth tables out of the dev bootstrap into the
migration chain. It is fully idempotent (double-run is a no-op):

1. `CREATE TABLE IF NOT EXISTS` for the nine growth tables
   (`loyalty_points`, `loyalty_transactions`, `loyalty_rewards`,
   `loyalty_redemptions`, `customer_referrals`,
   `referral_leaderboard_periods`, `referral_leaderboard_entries`,
   `marketing_campaigns`, `campaign_variants`) with column definitions
   verbatim from `scripts/init-local-postgres.sql`, plus the
   `users.referral_code` / `users.referred_by_code` columns.
2. Re-issues the two 0093 performance indexes
   (`idx_loyalty_transactions_user_created`, `idx_marketing_campaigns_activity`)
   that no-op'd on fresh deploys behind `to_regclass()` guards.
3. Re-issues / issues the 0103-style guarded
   `ALTER PUBLICATION powersync ADD TABLE` for all nine tables, and grants
   `SELECT` to `powersync_replication` where that role exists.

Apply it with the standard drizzle chain (migrations run in filename order);
no manual step is required beyond the normal deploy.

## 3. Seed execution

Preview (no gate, no writes):

```bash
npx tsx scripts/seed/pilot_unilag.ts --dry-run
```

Execute (env-gated, single transaction, idempotent):

```bash
PILOT_SEED=1 DATABASE_URL=postgresql://... npx tsx scripts/seed/pilot_unilag.ts
```

Seeds: 3 Lagos zones (`UNILAG-CAMPUS`, `AKOKA`, `YABA` in
`operations.service_zone`, tenant `switchos-core`); verticals
food-delivery/grocery/pharmacy; 10 merchants; 20 couriers; 50 consumers with
pre-provisioned `UNILAGnnn` referral codes; 3 healthcare + 3 freight
`business_travel_accounts`; the "Unilag Campus Launch" referral campaign
(WhatsApp channel); 3 referral incentive rewards; the current-month
leaderboard period. Pilot rows use stable ids 9001+ so re-runs converge.

## 4. Smoke tests

After seed + deploy, verify the consumer and operator surfaces:

```bash
# Unit/contract surface (26 tests, mocks at the pool/policy boundary)
npx vitest run server/growth.test.ts

# tRPC surface (requires an authenticated consumer session):
#   growth.myReferralCode           → 8-char code, stable across calls
#   growth.myReferrals              → empty list + zeroed summary
#   growth.applyReferralCode        → apply a second consumer's code;
#                                     replay with the same idempotencyKey
#                                     returns the stored response
#   growth.myLoyaltyBalance         → 200-pt welcome bonus visible
#   growth.myLoyaltyTransactions    → 'referral' journal entry
#   growth.listActiveCampaigns      → "Unilag Campus Launch" (public)
#   growth.listRewardsCatalog       → pilot incentives (public)
# Operator (MFA + operate policy):
#   growth.leaderboardSummary       → current period + loyalty totals
#   growth.createCampaign/updateCampaign → campaign row round-trip
```

Consumer UI: `/account/referrals` (ConsumerReferrals page) renders code +
WhatsApp share intent, referral list/status, loyalty balance, rewards catalog
and active campaigns.

## 5. Rollback

- **Seed data**: all pilot rows are isolated by stable id ranges
  (9001-9601) and the `@unilag.pilot.switchos.ng` domain. Delete by id range
  in reverse dependency order (redemptions/referrals → rewards/campaign →
  accounts/drivers/providers/users → zones) inside one transaction. The seed
  never touches non-pilot rows.
- **Router surface**: unmount `growth: growthRouter` from `server/routers.ts`
  and the `/account/referrals` route from `client/src/App.tsx` (single line
  each); no schema change required.
- **Migration 0105**: all statements are additive and IF-NOT-EXISTS guarded,
  so no down-migration is needed for a deploy rollback. If the tables must be
  dropped, drop in FK-safe order: `campaign_variants`,
  `referral_leaderboard_entries`, `customer_referrals`, `loyalty_redemptions`,
  `loyalty_transactions`, `marketing_campaigns`,
  `referral_leaderboard_periods`, `loyalty_rewards`, `loyalty_points` — after
  `ALTER PUBLICATION powersync DROP TABLE ...` for each published table.
  **Warning**: dropping these tables destroys live referral/loyalty data on
  any environment that has served traffic; prefer surface-level rollback.
