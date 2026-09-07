#!/usr/bin/env python3
"""Refresh LongCat merchant benchmark snapshots using Similarweb data APIs."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.append('/opt/.manus/.sandbox-runtime')
from data_api import ApiClient  # type: ignore

OUTPUT_PATH = Path(__file__).resolve().parents[1] / "validation" / "longcat_merchant_benchmarks.json"
TARGETS = [
    {"domain": "doordash.com", "label": "DoorDash"},
    {"domain": "ubereats.com", "label": "Uber Eats"},
    {"domain": "grubhub.com", "label": "Grubhub"},
]


def call_api(client: ApiClient, name: str, domain: str, query: dict[str, Any]) -> Any:
    return client.call_api(name, path_params={"domain": domain}, query=query)


def extract_latest_point(payload: Any, value_keys: list[str]) -> float | int | None:
    if isinstance(payload, dict):
        for key in ("data", "records", "visits", "ranks", "result"):
            value = payload.get(key)
            if isinstance(value, list) and value:
                return extract_latest_point(value[-1], value_keys)
        for key in value_keys:
            if key in payload and isinstance(payload[key], (int, float)):
                return payload[key]
    elif isinstance(payload, list) and payload:
        return extract_latest_point(payload[-1], value_keys)
    return None


def main() -> None:
    client = ApiClient()
    results: list[dict[str, Any]] = []

    for target in TARGETS:
        domain = target["domain"]
        base = {"main_domain_only": True}
        visits = call_api(client, 'SimilarWeb/get_visits_total', domain, base)
        bounce = call_api(client, 'SimilarWeb/get_bounce_rate', domain, base)
        rank = call_api(client, 'SimilarWeb/get_global_rank', domain, base)
        desktop_sources = call_api(client, 'SimilarWeb/get_traffic_sources_desktop', domain, base)
        countries = call_api(client, 'SimilarWeb/get_total_traffic_by_country', domain, {**base, 'limit': '3'})

        results.append({
            "domain": domain,
            "label": target["label"],
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "visits_total_latest": extract_latest_point(visits, ["visits", "visits_total", "value"]),
            "bounce_rate_latest": extract_latest_point(bounce, ["bounce_rate", "value"]),
            "global_rank_latest": extract_latest_point(rank, ["global_rank", "rank", "value"]),
            "traffic_sources_desktop": desktop_sources,
            "top_countries": countries,
            "raw": {
                "visits": visits,
                "bounce": bounce,
                "rank": rank,
            },
        })

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "similarweb",
        "benchmarks": results,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
