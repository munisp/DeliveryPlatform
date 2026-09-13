#!/usr/bin/env python3
"""Deterministic local arithmetic simulation; does not contact cluster services."""
from __future__ import annotations

import argparse
import json
import math
import re
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class GateScenario:
    name: str
    available_workers: int
    desired_workers: int
    max_surge: str
    poolers: int
    exporter_targets: int
    exporter_min_up: int
    backend_connections: int
    waiting_clients: int
    oldest_wait_seconds: float
    worker_client_ceiling: int


def evaluate_gate(scenario: GateScenario) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    if not 16 <= scenario.available_workers <= 64:
        reasons.append("tracker_worker_count_outside_16_to_64_envelope")
    if not 16 <= scenario.desired_workers <= 64:
        reasons.append("tracker_worker_desired_count_outside_16_to_64_envelope")
    if scenario.max_surge != "0":
        reasons.append("max_surge_zero_overlay_not_observed")
    if scenario.poolers != 4:
        reasons.append("unexpected_ready_pooler_count")
    if scenario.exporter_targets != 4:
        reasons.append("exporter_count")
    if scenario.exporter_min_up != 1:
        reasons.append("exporter_health")
    if scenario.backend_connections > 48:
        reasons.append("backend_connections")
    if scenario.waiting_clients > 0:
        reasons.append("queued_clients")
    if scenario.oldest_wait_seconds > 0.5:
        reasons.append("oldest_wait")
    if scenario.worker_client_ceiling > 256:
        reasons.append("worker_client_ceiling")
    return not reasons, reasons


def extract_keda_query(path: Path) -> str:
    content = path.read_text(encoding="utf-8")
    match = re.search(r"query:\s+>-\s*\n(?P<query>(?:\s{10,}.*\n){1,8})", content)
    if not match:
        raise ValueError("could not extract KEDA PromQL query")
    lines = [line.strip() for line in match.group("query").splitlines()]
    return "\n".join(lines)


def next_tick_at_or_after(after_seconds: float, period_seconds: int) -> int:
    return int(math.ceil(after_seconds / period_seconds) * period_seconds)


def next_tick_strictly_after(at_seconds: float, period_seconds: int) -> int:
    return (int(math.floor(at_seconds / period_seconds)) + 1) * period_seconds


def keda_visibility(
    change_time: float,
    worker_refresh: int,
    scrape: int,
    scrape_timeout: int,
    poll: int,
    missed_scrapes: int,
) -> dict[str, float | int]:
    # Conservative ordering: a state change just after a refresh waits for the
    # next worker refresh. A scrape scheduled on that same boundary may already
    # be in progress, so the next scrape is used. The value reaches Prometheus
    # no later than the configured scrape timeout, then waits for a KEDA poll.
    refresh_seen = next_tick_at_or_after(change_time, worker_refresh)
    first_eligible_scrape = next_tick_strictly_after(refresh_seen, scrape)
    scrape_started = first_eligible_scrape + (missed_scrapes * scrape)
    sample_available = scrape_started + scrape_timeout
    keda_seen = next_tick_at_or_after(sample_available, poll)
    return {
        "change_time_seconds": change_time,
        "missed_scrapes_before_success": missed_scrapes,
        "worker_refresh_seen_seconds": refresh_seen,
        "prometheus_successful_scrape_started_seconds": scrape_started,
        "prometheus_sample_available_by_seconds": sample_available,
        "keda_poll_seen_seconds": keda_seen,
        "visibility_delay_seconds": keda_seen - change_time,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keda-manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    query = extract_keda_query(args.keda_manifest)
    desired_workers = 64
    worker_pool_max = 4
    legacy_surge_percent = 25
    legacy_surge_pods = math.ceil(desired_workers * legacy_surge_percent / 100)
    safe_surge_pods = 0

    scenarios = [
        GateScenario("safe_64_worker_pre_rollout", 64, 64, "0", 4, 4, 1, 48, 0, 0.5, 256),
        GateScenario("legacy_25_percent_surge_config", 64, 64, "25%", 4, 4, 1, 48, 0, 0.5, 256),
        GateScenario("surged_80_worker_state", 80, 80, "25%", 4, 4, 1, 48, 0, 0.5, 320),
        GateScenario("backend_headroom_consumed", 64, 64, "0", 4, 4, 1, 49, 0, 0.5, 256),
        GateScenario("queue_already_present", 64, 64, "0", 4, 4, 1, 48, 1, 0.7, 256),
    ]
    results = []
    for scenario in scenarios:
        passed, reasons = evaluate_gate(scenario)
        results.append({"scenario": asdict(scenario), "passed": passed, "reasons": reasons})

    # Best case occurs when the change aligns with a worker refresh/scrape/poll.
    # Worst ordinary alignment occurs immediately after all three prior ticks.
    visibility = {
        # The theoretical best assumes refresh, scrape, and query completion
        # occur in that order immediately before a KEDA poll at t=0.
        "best_aligned_delay_seconds": 0,
        "conservative_ordinary_alignment": keda_visibility(0.001, 15, 15, 10, 30, 0),
        "after_one_missed_scrape": keda_visibility(0.001, 15, 15, 10, 30, 1),
        "after_two_missed_scrapes": keda_visibility(0.001, 15, 15, 10, 30, 2),
        "parameters": {
            "worker_metrics_refresh_seconds": 15,
            "prometheus_scrape_interval_seconds": 15,
            "service_monitor_scrape_timeout_seconds": 10,
            "keda_polling_interval_seconds": 30,
            "keda_query_timeout_seconds": 5,
            "keda_cooldown_seconds": 600,
            "keda_fallback_after_consecutive_failures": 3,
            "prometheus_default_instant_query_lookback_seconds": 300,
        },
    }

    report = {
        "simulation_type": "local_deterministic_arithmetic_only",
        "keda_query": query,
        "rollout_math": {
            "desired_workers": desired_workers,
            "worker_pool_max_connections": worker_pool_max,
            "steady_worker_client_ceiling": desired_workers * worker_pool_max,
            "legacy_max_surge_percent": legacy_surge_percent,
            "legacy_surge_pods": legacy_surge_pods,
            "legacy_peak_workers": desired_workers + legacy_surge_pods,
            "legacy_peak_worker_client_ceiling": (desired_workers + legacy_surge_pods) * worker_pool_max,
            "safe_max_surge_pods": safe_surge_pods,
            "safe_peak_workers": desired_workers + safe_surge_pods,
            "safe_peak_worker_client_ceiling": (desired_workers + safe_surge_pods) * worker_pool_max,
            "safe_max_unavailable": 1,
        },
        "admission_gate": {"scenarios": results},
        "keda_visibility": visibility,
        "limitations": [
            "The calculation does not simulate Kubernetes scheduling, HPA reconciliation, Prometheus query execution, PgBouncer, or PostgreSQL.",
            "KEDA queries Prometheus directly; the manifest query has no source-sample freshness predicate, so Prometheus default lookback behavior can retain an old sample longer than the ordinary 60-second observation path.",
            "The overdue-cursor expression is bounded to one value per provider/integration work lane but its raw query cost still grows with the number of exported worker and integration label sets.",
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
