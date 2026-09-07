# Developer Webhook Dispatch: `SKIP LOCKED` Performance and Fencing-Token Analysis

**Date:** 2026-09-06

**Scope:** Static assessment of the current claim query and dispatcher implementation, supported by official PostgreSQL documentation. It is not a production load test or a throughput certification.

## Current claim protocol

The claim function selects at most 100 due records, in due-time order, and uses a row lock with `SKIP LOCKED`. It immediately changes every selected record to `retrying`, increments its attempt counter, assigns a fresh UUID claim token, and sets a 30-second expiry. The actual TypeScript dispatcher requests a maximum of 25 records per cycle and processes them serially.

```sql
WHERE delivery.state IN ('pending'::developer.webhook_delivery_state,
                         'retrying'::developer.webhook_delivery_state)
  AND delivery.next_attempt_at <= p_now
  AND delivery.attempt_count < 16
  AND (
    delivery.state = 'pending'::developer.webhook_delivery_state
    OR delivery.claim_expires_at IS NULL
    OR delivery.claim_expires_at <= p_now
  )
ORDER BY delivery.next_attempt_at, delivery.created_at
FOR UPDATE SKIP LOCKED
LIMIT p_limit
```

PostgreSQL documents that `SKIP LOCKED` skips rows that cannot be locked immediately. This produces an inconsistent view and is not appropriate for a general-purpose read, but it is specifically appropriate for avoiding contention among multiple consumers of a queue-like table.[1] A `FOR UPDATE` lock prevents other lockers and writers from acting on the same row until the transaction finishes; row locks do not block ordinary readers.[2]

## What protects correctness

| Layer | Protection | What it prevents | Limitation |
|---|---|---|---|
| Transactional claim | `FOR UPDATE SKIP LOCKED` and one statement-level CTE claim/update | Two concurrent transactions claiming the same currently unlocked row. | It only protects rows while the transaction holds the row lock. |
| Durable lease | `claim_token` plus `claim_expires_at` | A second worker claiming a row with a still-valid lease. | An expired lease can be re-claimed, as intended for recovery. |
| Completion fence | Completion locks the row, checks state, exact token, and unexpired expiry | A stale worker changing the status, retry time, or terminal state after a newer claim. | It fences database state; it cannot recall an HTTP request already emitted by a stale worker. |
| Delivery identity | Unique `(webhook_endpoint_id, event_id)` | Duplicate durable rows for one endpoint/event pair. | It does not guarantee an endpoint receives a request only once; consumers must deduplicate `X-Delivery-Id`. |

## Current high-volume throughput constraints

The dispatcher starts an immediate cycle and then polls every five seconds. Within a process, `dispatchInFlight` prevents overlap. It claims up to 25 rows and processes the claimed rows inside a sequential `for ... of` loop, awaiting each HTTP request and its completion update before beginning the next one.

| Static bound or property | Current value | Interpretation |
|---|---:|---|
| Poll interval | 5 seconds | Limits fast-cycle dispatches to at most one cycle per interval per process. |
| Claim limit used by dispatcher | 25 | A cycle can reserve 25 delivery leases. |
| HTTP deadline per delivery | 10 seconds | A slow endpoint can consume the full deadline before the next row begins. |
| Durable lease | 30 seconds | Leases are three times the individual HTTP deadline. |
| Fast-cycle upper bound | 5.00 attempts/second/process | `25 / 5`; this assumes every HTTP call and database write finishes sufficiently quickly. It is not a benchmark result. |
| Serial batch at timeout | 250 seconds | `25 × 10 seconds`; a full timeout batch would far outlive the 30-second lease. |
| Serial timeout bound | 0.100 attempts/second/process | `25 / 250 seconds`; this excludes overhead. |
| Database pool maximum | 4 connections | It does not raise delivery concurrency because the JavaScript loop awaits each request serially. |
| Writes in a 16-attempt failed lifecycle | 32 row updates | One claim update and one completion update for each attempt, before index/trigger overhead. |

The 250-second serial-timeout case is a correctness concern as well as a performance constraint. After 30 seconds, another worker can legitimately re-claim an uncompleted row. The original worker’s late database completion is fenced by its obsolete token, but the original outbound HTTP request may already have reached the endpoint. This is why the partner’s `X-Delivery-Id` deduplication is required and why the lease duration, batch size, and delivery concurrency must be designed together.

## `SKIP LOCKED` cost profile at scale

`SKIP LOCKED` avoids wait queues on already claimed rows and usually improves worker utilization when several consumers contend for a delivery table. It does not make a PostgreSQL table a zero-cost message broker. Row locking can cause disk writes, and each delivery attempt in this design also updates the indexed delivery row on claim and on completion.[2] Under a retry storm, this increases WAL volume, index maintenance, dead tuples, and autovacuum work.

The current partial index is `developer_webhook_delivery_dispatch_idx ON developer.webhook_delivery (next_attempt_at) WHERE state IN ('pending', 'retrying')`. It can narrow the search to eligible states and support a due-time scan, but it does not fully order by the query’s `(next_attempt_at, created_at)` pair and does not exclude exhausted `attempt_count = 16` rows. If many deliveries share a due timestamp—especially after synchronized outage retries—the planner may scan/filter or sort more candidates before it can lock a small batch. Repeatedly locked early rows are skipped, so strict global FIFO cannot be guaranteed. PostgreSQL explicitly cautions that `SKIP LOCKED` returns an inconsistent selection; queue work can accept this, but workload monitoring must track oldest due delivery age and avoid starvation.[1]

## Recommended production hardening before high-volume enablement

| Priority | Change | Rationale | Validation required |
|---|---|---|---|
| P0 | Do not operate 25 serial requests behind a 30-second lease. Either reduce the safe initial claim limit to two, or implement bounded concurrent delivery where the largest batch completes well within the lease. | At two serial 10-second requests, 10 seconds of lease margin remains; it is an operational containment, not a scale solution. | Multi-worker test with slow endpoints and a proof that no token expires during a normal batch. |
| P0 | Require endpoint-level idempotency keyed by `X-Delivery-Id` and publish it in integration documentation. | HTTP is at-least-once under crashes and lease expiry; a database fence cannot prevent an already-sent duplicate. | Consumer contract test: replay the same delivery ID and verify one business effect. |
| P1 | Add bounded parallelism with a per-process concurrency limit and set the claim limit no greater than that limit, or add a token-bound lease-renewal operation for longer-running attempts. | Aligns the batch’s maximum time with the lease and increases throughput without unbounded sockets. | Load test at intended worker count with 10-second endpoint failures and lease-expiry metrics. |
| P1 | Add a concurrent partial index aligned to the claim order: `(next_attempt_at, created_at)` with `WHERE state IN ('pending','retrying') AND attempt_count < 16`. | Reduces scanning/sorting work for the ordered due-queue claim. `CREATE INDEX CONCURRENTLY` avoids blocking ordinary writes during creation. | `EXPLAIN (ANALYZE, BUFFERS)` on a production-shaped non-production dataset, before and after the index. |
| P1 | Apply bounded deterministic or randomized retry jitter and record it with the delivery. | Prevents large outage cohorts from all becoming due at the exact same power-of-two second. | Statistical distribution test and retry-age SLO test. |
| P1 | Monitor claimed-but-uncompleted leases, expired leases, stale-token rejections, oldest due age, dead letters, lock waits, WAL, dead tuples, and autovacuum lag. | Reveals claim contention, application slowness, retry storms, and table maintenance pressure before delivery loss/backlog. | Dashboard/alert verification at planned concurrency. |

No `CREATE INDEX CONCURRENTLY`, dispatcher-parallelism change, jitter policy, external endpoint idempotency contract, or high-volume load test was applied in this task. Those items remain recommendations until implemented and validated.

## SQLSTATE `55000` handling

`developer.complete_webhook_delivery` deliberately raises SQLSTATE `55000` when its locked row is no longer `retrying` with the supplied active unexpired token:

```sql
IF v_delivery.claim_token IS DISTINCT FROM p_claim_token
  OR v_delivery.claim_expires_at IS NULL
  OR v_delivery.claim_expires_at < p_now THEN
  RAISE EXCEPTION 'webhook delivery claim is stale or owned by another worker'
    USING ERRCODE = '55000';
END IF;
```

The SQL function does not swallow this error; raising it aborts that completion invocation. The current dispatcher also does not catch it at an individual completion-call boundary. Its outer `finally` releases `dispatchInFlight`, and the durable row remains under the newer owner or, after expiry, becomes eligible for recovery. This avoids a stale worker corrupting durable state, but production telemetry should classify SQLSTATE `55000` as an expected fencing event rather than silently dropping it. It should record delivery ID, token age, and worker identity without logging the token itself.

## Evidence boundary

The accompanying retry script and log validate claim token rotation, stale-token rejection, deadline scheduling, early-claim rejection, and terminal dead-letter state in a disposable local PostgreSQL/PostGIS database. They do not establish production throughput, lock latency, WAL growth, autovacuum behavior, endpoint idempotency, or multi-pod dispatch capacity.

## References

[1] [PostgreSQL 18 Documentation: `SELECT` locking clause and `SKIP LOCKED`](https://www.postgresql.org/docs/current/sql-select.html)

[2] [PostgreSQL 18 Documentation: Explicit locking and row-level locks](https://www.postgresql.org/docs/current/explicit-locking.html)
