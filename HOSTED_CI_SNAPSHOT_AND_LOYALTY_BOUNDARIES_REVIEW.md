# Hosted CI, Snapshot Rollback, and Loyalty Concurrency Boundary Review

## Executive Result

The repository now contains the database-integration workflow definition at `ci/security-redteam.yml`, and its disposable PostgreSQL job was validated manually against PostgreSQL 16. GitHub Actions activation is presently blocked by the repository integration token: GitHub rejected the workflow push because the token does not include the `workflows` permission. A local `act` run also reached the service-container setup but cannot complete in this sandbox because the kernel does not provide the `iptables` raw table required by Docker bridge networking.

## Hosted Workflow Activation

| Item | Result | Evidence |
|---|---|---|
| Workflow definition | Ready | `ci/security-redteam.yml` defines PostgreSQL 16 service, migrations, seed, integration, concurrency, and rollback steps |
| GitHub Actions API listing | Blocked | GitHub returned `403 Resource not accessible by integration` |
| Push to `.github/workflows/security-redteam.yml` | Blocked | GitHub App rejected the write without `workflows` permission |
| Local CI-equivalent execution | Passed manually | Database-backed suite, concurrency suite, and rollback rehearsal were run against the isolated PostgreSQL 16 database |
| Local `act` hosted-job simulation | Infrastructure-blocked | Docker could not create the service bridge due to missing kernel `iptables` raw table |

To activate the workflow, a repository administrator must grant the GitHub App token **Actions workflows: Read and write** permission, then commit/copy `ci/security-redteam.yml` to `.github/workflows/security-redteam.yml`.

## Snapshot-File Rollback Rehearsal

The rollback harness accepts a pre-exported `ROLLBACK_SNAPSHOT_FILE` and refuses a production-looking target URL or non-empty target database. A synthetic sanitized staging snapshot was exported, restored to a fresh isolated target, then migration `0005_users_phone_for_growth_idempotency.sql` was applied and reversed with its down migration.

| Integrity check | Expected | Result |
|---|---:|---:|
| Users retained after restore and rollback | 2 | 2 |
| Campaigns retained after restore and rollback | 5 | 5 |
| `users.phone` after down migration | absent | absent |
| Target safety | empty isolated database only | enforced |

This proves the mechanics for the specific reversible migration. It is not evidence of a real production snapshot rehearsal because no sanitized production snapshot was supplied to this environment.

## 100-Way Loyalty Redemption Transaction Boundaries

The detailed synthetic log is stored separately as `loyalty_100way_transaction_boundaries.json`. It records only disposable test data.

| Boundary | Observed evidence |
|---|---|
| Attempt count | 100 unique idempotency keys |
| Accepted redemptions | 10 |
| Rejected redemptions | 90 |
| Starting credit | +1,000 points in one bonus transaction |
| Debit records | 10 rows, each `-100` points |
| Redemption records | 10 approved rows, each 100 points spent |
| Final balance | 0 |
| Negative balance | never observed |

The business invariant is `1,000 + (10 × -100) = 0`. The transaction log began with the bonus credit and ended with the tenth redemption debit. The loyalty implementation locks the account row with `FOR UPDATE`, verifies funds under lock, performs a guarded `points_balance >= cost` update, writes the debit transaction and redemption record, then commits. Therefore a failed attempt cannot record a redemption or debit, and a successful attempt contributes both records in the same transaction.
