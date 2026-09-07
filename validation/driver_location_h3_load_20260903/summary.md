# 10,000-Driver Location and H3 Query Load Results

**Status:** PASSED

| Metric | Location ingest | H3 spatial query |
| --- | ---: | ---: |
| Requests | 10000 | 10000 |
| p50 (ms) | 15012.564 | 5964.343 |
| p90 (ms) | 17626.305 | 11791.92 |
| p95 (ms) | 17912.15 | 12454.314 |
| p99 (ms) | 18063.253 | 13199.625 |
| Max (ms) | 18180.373 | 16175.604 |
| Transport errors | 0 | 0 |

| Durable/cache invariant | Observed | Expected |
| --- | ---: | ---: |
| Accepted location events | 10000 | 10000 |
| Rejected location events | 0 | 0 |
| H3 durable projections | 10000 | 10000 |
| Redis GEO members | 10000 | 10000 |
| Redis H3 members | 10000 | 10000 |
| PostgreSQL deadlocks delta | 0 | 0 |
| PostgreSQL max lock waiters | 0 | informational |

All durable event, H3 projection, Redis GEO/H3 cache, HTTP, and deadlock assertions passed.
