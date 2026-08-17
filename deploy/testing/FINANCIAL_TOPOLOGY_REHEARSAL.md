# Financial Topology Rehearsal

This is a **disposable real-service rehearsal**, not a production deployment. It starts an empty PostgreSQL database, a three-replica TigerBeetle cluster, one Redpanda broker, a persistent Temporal development service, and dedicated Mojaloop API, outbox-worker, Temporal bridge, and Temporal worker processes. It never accepts production credentials, production databases, or customer data.

> The rehearsal starts only on a Linux host with Docker, functional Docker bridge endpoint attachment, and at least **5 GiB currently available memory**. Redpanda runs with a 768 MiB allocation inside a 1 GiB container ceiling, and the three TigerBeetle replicas retain their 256 MiB cache grids. This safety margin covers the full test stack without removing a ledger replica or recovery phase. The harness deliberately refuses more constrained or stale environments rather than producing partial financial-test evidence.

| Component | Pinned rehearsal version | Purpose | Explicit limitation |
|---|---:|---|---|
| TigerBeetle | `0.17.9` | Three replicas on ports `3001-3003` with `--cache-grid=256MiB` | Same-host replicas do not demonstrate multi-host or regional durability. |
| PostgreSQL | `16` | Migration-owned workflow, idempotency, and outbox records | Uses a fresh test database only. |
| Redpanda | `v26.2.1` | Kafka-compatible outbox delivery and broker recovery | Allocated 768 MiB inside a 1 GiB container ceiling; one broker is a test fixture, not a production quorum. |
| Temporal CLI | `1.8.2` | Development server, bridge, and worker restart validation | Its SQLite file persists through the service stop/start sequence only; it is not a production persistence design. |
| Mojaloop | Local build | Ledger-first outbox, authenticated bridge, and worker | Uses the service’s fail-closed credentials and schema contract. |

## Start and Execute

From the repository root on a capable disposable host, execute:

```bash
scripts/rehearse-financial-topology.sh
```

The script creates a local `0600` environment file with random test-only secrets, formats three new TigerBeetle data files, applies migrations `0006` and `0007`, verifies all service ports and health endpoints, and then performs the following sequence.

| Test stage | Required assertion |
|---|---|
| Ledger baseline | Account creation, controlled test funding, duplicate replay idempotency, insufficient-funds rejection, partial refund, full refund, and reconciliation all run against real TigerBeetle. |
| Broker partition | Redpanda is stopped; the TigerBeetle leg must be delivered first while downstream Kafka and Temporal intents remain durable and retryable. |
| Broker recovery | Redpanda is restored; the Kafka outbox delivery completes without adding a second ledger transfer. |
| Temporal partition | Temporal and its worker are stopped; the durable outbox retains the Temporal intent for retry. |
| Bridge recovery | Temporal is restored; the authenticated bridge uses the workflow ID as Temporal’s idempotent workflow identity. |
| Worker recovery | The worker starts after workflow persistence and must complete the durable orchestration record. |

The script stores `compose.log` and `reconciliation-overview.json` beneath `.financial-rehearsal/`. Remove this directory and the Compose volumes only after preserving required evidence.

## Funds-Safety Boundary

TigerBeetle remains the ledger authority. The transactional outbox sends the TigerBeetle destination before non-ledger destinations, while duplicate delivery uses stable idempotency keys. Refund initiation locks the original transfer row and counts both `PENDING_LEDGER` and completed refunds against the original amount. Therefore a disconnected ledger, broker, or worker reserves the remaining amount instead of allowing a second concurrent refund to over-allocate it. Temporal records and completes orchestration; it does not move ledger funds or compensate TigerBeetle entries.

This rehearsal does not prove production network policies, TLS/mTLS, secret-manager integration, a Redpanda quorum, multi-host TigerBeetle recovery, or self-hosted Temporal capacity. Those remain production release gates.

## References

[1] [TigerBeetle Docker Deployment](https://docs.tigerbeetle.com/operating/deploying/docker/)

[2] [TigerBeetle 0.17.9 Release](https://github.com/tigerbeetle/tigerbeetle/releases/tag/0.17.9)

[3] [Temporal CLI Development Server](https://docs.temporal.io/cli/setup-cli)

[4] [Redpanda Docker Quickstart](https://docs.redpanda.com/streaming/current/get-started/quick-start/)
