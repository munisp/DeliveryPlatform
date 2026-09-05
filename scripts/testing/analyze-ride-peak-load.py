#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path
from statistics import mean


OUTPUT = Path(sys.argv[1]).resolve()


def load_json(name: str) -> object:
    return json.loads((OUTPUT / name).read_text(encoding="utf-8"))


def read_single_csv(name: str) -> list[int]:
    row = (OUTPUT / name).read_text(encoding="utf-8").strip().split(",")
    return [int(value) for value in row]


def read_state_counts(name: str) -> dict[str, int]:
    result: dict[str, int] = {}
    for line in (OUTPUT / name).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        state, count = line.rsplit(",", 1)
        result[state] = int(count)
    return result


def summarize_samples(name: str) -> dict[str, object]:
    samples = load_json(name)
    assert isinstance(samples, list)
    latencies = sorted(float(sample["latency_ms"]) for sample in samples)
    statuses: dict[str, int] = {}
    states: dict[str, int] = {}
    errors = 0
    for sample in samples:
        status = str(sample["status"])
        statuses[status] = statuses.get(status, 0) + 1
        state = str(sample.get("state") or "none")
        states[state] = states.get(state, 0) + 1
        errors += int(bool(sample.get("error")))
    def percentile(value: float) -> float | None:
        if not latencies:
            return None
        return latencies[max(0, min(len(latencies) - 1, int((len(latencies) * value + 0.999999)) - 1))]
    return {
        "requests": len(samples),
        "min_ms": latencies[0] if latencies else None,
        "mean_ms": mean(latencies) if latencies else None,
        "p50_ms": percentile(0.50),
        "p95_ms": percentile(0.95),
        "p99_ms": percentile(0.99),
        "max_ms": latencies[-1] if latencies else None,
        "status_counts": statuses,
        "state_counts": states,
        "transport_errors": errors,
    }


def format_metric(value: object) -> str:
    return "—" if value is None else f"{float(value):.3f}"


def main() -> None:
    http_summary = load_json("http_summary.json")
    dispatch = summarize_samples("dispatch.json")
    payment = summarize_samples("payment.json")
    pg_before = read_single_csv("pg_stats_before.csv")
    pg_after = read_single_csv("pg_stats_after.csv")
    pg_delta = {
        "xact_commit": pg_after[0] - pg_before[0],
        "xact_rollback": pg_after[1] - pg_before[1],
        "deadlocks": pg_after[2] - pg_before[2],
        "blks_read": pg_after[3] - pg_before[3],
        "blks_hit": pg_after[4] - pg_before[4],
    }
    lock_rows = []
    with (OUTPUT / "pg_lock_samples.csv").open(newline="", encoding="utf-8") as source:
        for row in csv.reader(source):
            if len(row) == 4:
                lock_rows.append([int(value) for value in row])
    max_sessions = max((row[1] for row in lock_rows), default=0)
    max_lock_waiters = max((row[2] for row in lock_rows), default=0)
    max_active = max((row[3] for row in lock_rows), default=0)
    dispatch_states = read_state_counts("dispatch_trip_states.csv")
    payment_states = read_state_counts("payment_states.csv")
    pending_offers = int((OUTPUT / "pending_offer_count.txt").read_text(encoding="utf-8").strip() or "0")
    processed_webhooks = int((OUTPUT / "processed_webhook_count.txt").read_text(encoding="utf-8").strip() or "0")
    redis_available = int((OUTPUT / "redis_available_driver_count.txt").read_text(encoding="utf-8").strip() or "0")

    result = {
        "http_driver": http_summary,
        "dispatch": dispatch,
        "payment": payment,
        "postgres_delta": pg_delta,
        "postgres_lock_sampling": {"samples": len(lock_rows), "max_sessions": max_sessions, "max_lock_waiters": max_lock_waiters, "max_active_sessions": max_active},
        "durable_state": {"dispatch_trip_states": dispatch_states, "payment_states": payment_states, "pending_offers": pending_offers, "processed_webhooks": processed_webhooks, "redis_available_drivers": redis_available},
    }
    (OUTPUT / "summary.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    report = [
        "# 5,000-Trip Peak-Hour Load Summary",
        "",
        "| Workload | Requests | p50 ms | p95 ms | p99 ms | Max ms | HTTP outcomes | Transport errors |",
        "|---|---:|---:|---:|---:|---:|---|---:|",
        f"| Dispatch matching | {dispatch['requests']} | {format_metric(dispatch['p50_ms'])} | {format_metric(dispatch['p95_ms'])} | {format_metric(dispatch['p99_ms'])} | {format_metric(dispatch['max_ms'])} | `{dispatch['status_counts']}` | {dispatch['transport_errors']} |",
        f"| Payment webhook | {payment['requests']} | {format_metric(payment['p50_ms'])} | {format_metric(payment['p95_ms'])} | {format_metric(payment['p99_ms'])} | {format_metric(payment['max_ms'])} | `{payment['status_counts']}` | {payment['transport_errors']} |",
        "",
        "## Durable Outcomes",
        "",
        f"- Dispatch trip states: `{dispatch_states}`.",
        f"- Payment states: `{payment_states}`.",
        f"- Pending offers: `{pending_offers}`; processed webhooks: `{processed_webhooks}`; Redis available drivers after matching: `{redis_available}`.",
        "",
        "## PostgreSQL Contention Sampling",
        "",
        f"- Transaction deltas: `{pg_delta}`.",
        f"- Samples: `{len(lock_rows)}`; maximum observed database sessions: `{max_sessions}`; maximum lock waiters: `{max_lock_waiters}`; maximum active sessions: `{max_active}`.",
    ]
    (OUTPUT / "summary.md").write_text("\n".join(report) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
