# Isolated PostgreSQL Integration Execution & Business Logic Review

**Environment:** disposable PostgreSQL 16 container on `127.0.0.1:55432`  
**Database:** `switchos_it`  
**Execution result:** **166/166 repository tests passed** with `DATABASE_URL` and `TEST_DATABASE_URL` directed exclusively to the disposable database.

## 1. Staging Setup and Schema Finding

The isolated database received migrations `0000` through `0004`, the local staging initializer, and a new migration `0005_users_phone_for_growth_idempotency.sql`. The real integration run uncovered a schema mismatch: referral and campaign idempotency flows insert `users.phone`, but the tracked schema had no `phone` column. The migration adds the nullable column safely, and the initializer now includes it.

| Finding | Risk if unresolved | Remediation | Verification |
|---|---|---|---|
| `users.phone` absent while referral/campaign test flows require it | Runtime insert failure in referral or campaign-audience flows | Added tracked migration `0005_users_phone_for_growth_idempotency.sql` and local initializer change | All idempotency tests passed against the migrated staging database |
| Reward fixture omitted `points_required` | Test fixture violated the required reward business schema | Fixture now sets `points_required` equal to `points_cost` | Loyalty redemption replay passed |
| Campaign retry assertion assumed an empty database | Notification count was brittle in a realistic seeded audience | Assertion now verifies that retry creates no additional sends | Audience delivery idempotency passed |

## 2. Executed Database-Backed Coverage

Although 27 tests were previously skipped, the selected four files execute **28 scenarios** because one growth statistical-significance test was already database-independent.

| Domain | Scenarios executed | Business rules proven by the isolated run | Failure modes covered |
|---|---:|---|---|
| Referral leaderboard | 5 | Exactly one active period is used; user entries are updated; rankings and user position are retrievable | Empty or absent user position returns no fabricated rank |
| Push tokens | 4 | Device tokens register, retrieve, deactivate, and expose log history | Deactivated tokens no longer represent active delivery endpoints |
| A/B campaigns | 6 | Variants persist, allocations update, sends/opens/clicks/conversions accumulate, performance rates are available, and statistical significance returns a typed result | Database-independent significance calculation remains available even when database tests are gated |
| Loyalty | 7 | New accounts begin at zero/bronze; awards increase balances; thresholds advance tiers; aggregate stats read correctly; sufficient redemption creates an approved voucher; insufficient redemption is rejected | Insufficient balance is a tested denial path |
| Marketplace intelligence | 3 | Seeded driver profile, dispatch strategy, ranked candidates, compensation multiplier, and cherry-pick risk are returned from real staging rows | Recommendations are based on seeded operational fields rather than static workspace mock data |
| Durable non-Mojaloop idempotency | 3 | Replaying the same redemption, referral apply/complete, or audience campaign key yields exactly one durable record/effect | Retry does not create duplicate redemptions, referrals, campaign sends, or email dispatches |

## 3. Failure-Mode Review

The executed suites cover core happy paths, two important denial paths, and durable retry safety. They do not by themselves prove every adversarial or operational failure mode.

| Domain | Covered failure modes | Remaining recommended scenarios |
|---|---|---|
| Referral and loyalty | Insufficient reward points; duplicate idempotency keys | Concurrent awards/redemptions, idempotency-key payload conflicts, deadlock retry, reward expiry and tier-ineligible redemption |
| Push notifications | Token deactivation | Provider delivery failure, invalid token cleanup, duplicate device registration under concurrency |
| A/B campaigns | Retry deduplication of audience sends | Allocation total over 100%, campaign cancellation during send, concurrent metric update races |
| Marketplace dispatch | Real data retrieval and ranked candidate fields | Offline driver, no candidates, stale performance data, competing dispatch reservations |
| Schema/bootstrap | Migration and seed success in a clean database | Upgrade from production snapshots and rollback rehearsal |

## 4. Enablement Procedure

Use a disposable database only:

```bash
export TEST_DATABASE_URL='postgresql://switchos:switchos@127.0.0.1:55432/switchos_it?sslmode=disable'
export DATABASE_URL="$TEST_DATABASE_URL"
scripts/run-db-backed-integration-tests.sh
pnpm exec vitest run
```

`scripts/run-db-backed-integration-tests.sh` refuses URLs containing `production` or `prod`, preventing accidental execution of write-heavy integration tests against a production-looking database.

## 5. Conclusion

The formerly skipped database-backed scenarios are now executable against an isolated staging database and pass end to end. This increases confidence in growth, loyalty, marketplace, and non-Mojaloop idempotency logic. It does not replace live deployment testing of external notification providers, production traffic behavior, or multi-service concurrency under real broker and Temporal infrastructure.
