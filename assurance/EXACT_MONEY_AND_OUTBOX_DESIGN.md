# Exact Money and Durable Funds Outbox Design

## Monetary boundary

All funds-facing Go API payloads and persisted domain structures will use unsigned integer **minor units** with an explicit ISO-4217-style currency code. Fractional JSON numbers, scientific notation, negative values, and amounts exceeding the signed PostgreSQL `BIGINT` range are rejected at the HTTP boundary. TigerBeetle receives the same validated minor-unit value; no float conversion or rounding function is permitted on a funds path.

The first schema migration is additive and reversible: it adds `amount_minor` / `fees_minor` / reconciliation minor-unit columns, verifies each legacy two-decimal value can be represented exactly, then backfills. The runtime reads and writes only minor-unit fields after the migration. Legacy decimal columns remain only for rollback compatibility until a separately rehearsed destructive migration retires them.

## Outbox boundary

Every funds state transition writes its domain record, workflow state/event, and one destination-specific outbox row per required side effect in **one PostgreSQL transaction**. An outbox record contains an immutable event ID, destination, idempotency key, payload, attempt state, next-attempt time, lock ownership, and delivery timestamp. A unique `(destination, idempotency_key)` constraint prevents duplicate intent creation.

An outbox dispatcher claims rows using `FOR UPDATE SKIP LOCKED`, publishes one destination at a time, and records either delivery or a bounded exponential-backoff failure in a separate transaction. Required destinations are fail-closed: missing configuration prevents funds acceptance rather than silently discarding the destination. Consumers must deduplicate on the immutable event ID. A Temporal record is an outbox destination, not an after-commit best-effort action.

## Recovery invariant

After a process crash, every committed funds mutation has either an undelivered outbox record eligible for retry or a recorded delivered state. No endpoint reports a remote side effect as complete until the durable state machine records the acknowledged outcome. Unknown remote outcomes remain explicitly reconciling and are never converted into a successful customer-facing response solely because the local ledger movement succeeded.
