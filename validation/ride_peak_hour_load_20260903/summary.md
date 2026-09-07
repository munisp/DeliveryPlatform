# 5,000-Trip Peak-Hour Load Summary

| Workload | Requests | p50 ms | p95 ms | p99 ms | Max ms | HTTP outcomes | Transport errors |
|---|---:|---:|---:|---:|---:|---|---:|
| Dispatch matching | 5000 | 41.452 | 72.840 | 173.806 | 273.610 | `{'200': 5000}` | 0 |
| Payment webhook | 500 | 89.114 | 134.364 | 161.485 | 177.331 | `{'202': 500}` | 0 |

## Durable Outcomes

- Dispatch trip states: `{'driver_offered': 5000}`.
- Payment states: `{'captured': 500}`.
- Pending offers: `5000`; processed webhooks: `500`; Redis available drivers after matching: `0`.

## PostgreSQL Contention Sampling

- Transaction deltas: `{'xact_commit': 5234, 'xact_rollback': 0, 'deadlocks': 0, 'blks_read': 11, 'blks_hit': 2345835}`.
- Samples: `32`; maximum observed database sessions: `27`; maximum lock waiters: `0`; maximum active sessions: `19`.
