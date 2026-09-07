#!/usr/bin/env python3
from __future__ import annotations

import json
import statistics
import sys
from collections import Counter
from pathlib import Path


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    rank = max(0, min(len(values) - 1, int((len(values) * fraction + 0.999999999) - 1)))
    return values[rank]


def read_single_int(path: Path) -> int:
    return int(path.read_text(encoding="utf-8").strip() or "0")


def metric(samples: list[dict], name: str) -> dict:
    latencies = sorted(float(sample["latency_ms"]) for sample in samples)
    statuses = Counter(str(sample["status"]) for sample in samples)
    outcomes = Counter(str(sample.get("state") or "none") for sample in samples)
    return {
        "operation": name,
        "requests": len(samples),
        "http_status": dict(sorted(statuses.items())),
        "transport_errors": sum(1 for sample in samples if sample.get("error")),
        "outcomes": dict(sorted(outcomes.items())),
        "min_ms": latencies[0] if latencies else None,
        "mean_ms": round(statistics.fmean(latencies), 3) if latencies else None,
        "p50_ms": percentile(latencies, 0.50),
        "p90_ms": percentile(latencies, 0.90),
        "p95_ms": percentile(latencies, 0.95),
        "p99_ms": percentile(latencies, 0.99),
        "max_ms": latencies[-1] if latencies else None,
    }


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: analyze-driver-location-h3-load.py OUT_DIR DRIVER_COUNT")
    out_dir = Path(sys.argv[1])
    expected = int(sys.argv[2])
    location = json.loads((out_dir / "location_updates.json").read_text(encoding="utf-8"))
    query = json.loads((out_dir / "h3_spatial_queries.json").read_text(encoding="utf-8"))
    location_metric = metric(location, "driver_location_ingest")
    query_metric = metric(query, "h3_spatial_candidate_query")
    for metric_value in (location_metric, query_metric):
        elapsed = max((sample["latency_ms"] for sample in (location if metric_value["operation"] == "driver_location_ingest" else query)), default=0.0)
        metric_value["sample_max_request_ms"] = elapsed
    before = [int(item) for item in (out_dir / "pg_stats_before.csv").read_text(encoding="utf-8").strip().split(",")]
    after = [int(item) for item in (out_dir / "pg_stats_after.csv").read_text(encoding="utf-8").strip().split(",")]
    events = [int(item) for item in (out_dir / "location_event_counts.csv").read_text(encoding="utf-8").strip().split(",")]
    lock_lines = [line.strip().split(",") for line in (out_dir / "pg_lock_samples.csv").read_text(encoding="utf-8").splitlines() if line.strip()]
    max_waiters = max((int(parts[2]) for parts in lock_lines), default=0)
    max_active = max((int(parts[3]) for parts in lock_lines), default=0)
    h3_projection_count = read_single_int(out_dir / "h3_projection_count.txt")
    redis_geo_count = read_single_int(out_dir / "redis_geo_count.txt")
    redis_h3_member_count = read_single_int(out_dir / "redis_h3_member_count.txt")
    failures = []
    for result in (location_metric, query_metric):
        if result["requests"] != expected or result["http_status"].get("200", 0) + result["http_status"].get("202", 0) != expected or result["transport_errors"]:
            failures.append(f"{result['operation']} did not complete {expected} successful HTTP requests")
    if events != [expected, 0, expected]:
        failures.append(f"durable location event counts were {events}, expected [{expected}, 0, {expected}]")
    if h3_projection_count != expected:
        failures.append(f"H3 durable projection count was {h3_projection_count}, expected {expected}")
    if redis_geo_count != expected or redis_h3_member_count != expected:
        failures.append(f"Redis projection counts were GEO={redis_geo_count}, H3={redis_h3_member_count}, expected {expected}")
    if after[2] - before[2] != 0:
        failures.append(f"PostgreSQL deadlocks increased by {after[2] - before[2]}")
    report = {
        "expected_driver_count": expected,
        "location_updates": location_metric,
        "h3_spatial_queries": query_metric,
        "durable_state": {"accepted_location_events": events[0], "rejected_location_events": events[1], "total_location_events": events[2], "h3_projection_records": h3_projection_count},
        "redis_state": {"geo_available_members": redis_geo_count, "h3_available_member_total": redis_h3_member_count},
        "postgresql": {"commits_delta": after[0] - before[0], "rollbacks_delta": after[1] - before[1], "deadlocks_delta": after[2] - before[2], "blocks_read_delta": after[3] - before[3], "blocks_hit_delta": after[4] - before[4], "max_lock_waiters": max_waiters, "max_active_sessions": max_active},
        "passed": not failures,
        "failures": failures,
    }
    (out_dir / "summary.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    lines = ["# 10,000-Driver Location and H3 Query Load Results", "", f"**Status:** {'PASSED' if report['passed'] else 'FAILED'}", "", "| Metric | Location ingest | H3 spatial query |", "| --- | ---: | ---: |"]
    for label, key in [("Requests", "requests"), ("p50 (ms)", "p50_ms"), ("p90 (ms)", "p90_ms"), ("p95 (ms)", "p95_ms"), ("p99 (ms)", "p99_ms"), ("Max (ms)", "max_ms"), ("Transport errors", "transport_errors")]:
        lines.append(f"| {label} | {location_metric[key]} | {query_metric[key]} |")
    lines.extend(["", "| Durable/cache invariant | Observed | Expected |", "| --- | ---: | ---: |", f"| Accepted location events | {events[0]} | {expected} |", f"| Rejected location events | {events[1]} | 0 |", f"| H3 durable projections | {h3_projection_count} | {expected} |", f"| Redis GEO members | {redis_geo_count} | {expected} |", f"| Redis H3 members | {redis_h3_member_count} | {expected} |", f"| PostgreSQL deadlocks delta | {after[2] - before[2]} | 0 |", f"| PostgreSQL max lock waiters | {max_waiters} | informational |", ""])
    if failures:
        lines.append("## Failed assertions")
        lines.extend(f"- {failure}" for failure in failures)
    else:
        lines.append("All durable event, H3 projection, Redis GEO/H3 cache, HTTP, and deadlock assertions passed.")
    (out_dir / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps(report))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
