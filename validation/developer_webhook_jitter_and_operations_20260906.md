# Developer Webhook Retry Jitter and Dead-Letter Operations Assessment

**Date:** 2026-09-06

## Implemented forward-only migration

`drizzle/0049_developer_webhook_retry_jitter.sql` follows migration `0048` and replaces only the token-aware `developer.complete_webhook_delivery` function. It preserves the `FOR UPDATE` row lock, claim-token fence, 30-second claim lease, HTTP status/error evidence, terminal attempt cap, and least-privilege grant. It changes non-terminal retry timing from a deterministic power-of-two delay to a **deterministic jittered delay**.

For a claimed failure with attempt count `a`, the migration calculates:

```text
base_seconds   = min(3600, 2^a)
window_seconds = max(1, ceil(base_seconds / 4))
seed           = SHA-256(delivery_uuid || ':' || a)
jitter_seconds = first_16_bits(seed) mod (window_seconds + 1)
delay_seconds  = base_seconds + jitter_seconds
```

The jitter is therefore positive and bounded at 25% of the base delay. It is stable for the same delivery and attempt, so an operator can recompute the scheduled time without storing or exposing a random seed. At attempt 16, the function transitions to `dead_letter`; it does not calculate jitter and leaves `next_attempt_at` unchanged.

| Failed claim attempt | Base delay | Jitter window | Actual scheduled delay |
|---:|---:|---:|---:|
| 1 | 2 seconds | 0–1 seconds | 2–3 seconds |
| 6 | 64 seconds | 0–16 seconds | 64–80 seconds |
| 11 | 2,048 seconds | 0–512 seconds | 2,048–2,560 seconds |
| 12–15 | 3,600 seconds | 0–900 seconds | 3,600–4,500 seconds |
| 16 | none | none | `dead_letter`; no retry |

The isolated validator applies migrations `0044`, `0045`, `0048`, and `0049` to a uniquely named local PostgreSQL/PostGIS database. It recomputes the same SHA-256-derived jitter inside SQL and asserts each `next_attempt_at`, the range bounds, no early claim, fresh claim tokens, stale-token rejection, valid completion, terminal transition, and no later dead-letter claim. The local simulation passed; its output is retained in `validation/developer_webhook_retry_jitter_simulation_20260906.txt`.

## Current dispatcher behavior

The current worker starts an immediate dispatch cycle and then calls `dispatchDeveloperWebhooks()` every five seconds only while `ENABLE_DEVELOPER_WEBHOOK_DISPATCH` is enabled. It publishes outbox events, claims a bounded batch, signs and sends each delivery, then invokes the database completion function. Any non-2xx response or transport failure is counted by the worker as `retried`; it does not inspect the completion function’s returned state.

| Operational event | Current worker behavior | Current evidence or notification |
|---|---|---|
| HTTP 2xx | Completes delivery as successful. | Returns `delivered` count from the in-process dispatch result only. |
| HTTP non-2xx / transport failure | Calls completion with failure state and records the status/error. | Returns `retried` count, even if the function terminally changes the row to `dead_letter`. |
| `dead_letter` state | Persisted by PostgreSQL at failed attempt 16. The row is no longer claimable. | No separate worker notification, event, metric, dashboard, or operator replay workflow exists in the reviewed dispatcher. |
| Database/dispatcher exception | The scheduled callback logs `console.error("[SwitchOS] Developer webhook dispatch failed", error)`. | Process log only; no structured metric or alert sink is wired for developer webhook operations. |
| Fencing rejection (`55000`) | Completion call throws; the current per-delivery loop does not catch it independently. The outer `finally` clears the local in-flight guard. | Process log via scheduled callback if the exception propagates; no stale-token metric or alert. |

> The system has durable terminal state and bounded retry behavior but **does not currently implement dead-letter notifications or monitoring alerts** for Developer API webhooks. It must not be represented as having production alerting merely because the database records `dead_letter`.

## Recommended production observability work

Before production enablement, a separate reviewed change should add read-only operational metrics and an access-controlled dead-letter review/replay workflow. It should avoid sending raw payloads or secrets into metrics or alerts. At minimum, expose counts for `pending`, `retrying`, `delivered`, and `dead_letter`; oldest due age; active/expired leases; completion status class; stale-token rejections; and retry-delay distribution. An alert should be based on a rate or age threshold plus retained operator evidence, not one alert per failed delivery.

The current implementation does not provide an external notification channel, metrics endpoint, or automatic replay mechanism, and no such integration was deployed or tested in this task.

## Sources

Jitter is used to spread retry attempts and reduce synchronized contention; unjittered exponential backoff still creates request clusters.[1] Retries should be idempotent and frequent retries can consume bandwidth and degrade a temporarily unavailable dependency.[2]

[1] [AWS Architecture Blog: Exponential Backoff and Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)

[2] [AWS Prescriptive Guidance: Retry with backoff pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/retry-backoff.html)
