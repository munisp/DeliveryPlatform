# Disposable PostgreSQL CI, Concurrency, and Rollback Rehearsal

## Verified isolated execution

An isolated PostgreSQL 16 container received the tracked migrations, the deterministic integration seed, and the `0005_users_phone_for_growth_idempotency.sql` correction. With both `DATABASE_URL` and `TEST_DATABASE_URL` pointed only at that disposable database, the full suite completed with **168/168 passing tests across 28 files**.

| Validation | Result | Evidence |
|---|---|---|
| Database-backed scenarios formerly skipped by default | 28/28 passed | Growth, loyalty, marketplace, and non-Mojaloop idempotency suites |
| Loyalty redemption race | Passed | 100 parallel unique redemptions from 1,000 points resulted in exactly 10 redemptions, 10 debits, and a zero—not negative—balance |
| Campaign allocation race | Passed | 100 concurrent allocation updates retained a total allocation of at most 100% |
| Reversible migration rehearsal | Passed | Isolated snapshot clone preserved 2 users and 4 campaigns while applying then rolling back `0005` |
| Full regression with database enabled | 168/168 passed | No tests remained skipped in the configured isolated run |

## CI configuration

`ci/security-redteam.yml` now contains a `database-integration` job that starts PostgreSQL 16 as a GitHub Actions service, applies migrations `0000`–`0005` plus the deterministic seed, runs the database-backed integration script and high-concurrency suite, then creates an empty rollback database for the rehearsal.

The local `act` attempt correctly parsed the job but could not start the service container because this sandbox kernel lacks the `iptables` raw table required for Docker bridge networking. The workflow is designed for a standard GitHub-hosted Ubuntu runner, where service containers use supported networking.

## Business-rule hardening

Campaign-variant creation and allocation updates now lock the campaign row in a transaction, calculate the aggregate allocation under lock, and reject operations that would exceed 100%. This closes the prior concurrent-update gap where two independent updates could both appear valid before either committed.

Loyalty redemption already locks the account row and debits with a `points_balance >= cost` predicate. The new 100-way test validates that these layers prevent an overdraft while allowing the exact number of redemptions funded by the balance.

## Safe production-snapshot rehearsal

`scripts/rehearse-migration-rollback.sh` now accepts `ROLLBACK_SNAPSHOT_FILE`, a pre-exported sanitized production snapshot, and refuses to run against a non-empty target or any production-looking target URL. This permits a read-only production snapshot to be copied into an isolated target without granting the rehearsal direct production connectivity.

> The rehearsal proves migration mechanics and row-count integrity for the specific reversible migration. It does not replace a full restore drill that includes production-scale data volume, extensions, role grants, encryption keys, and application traffic.

