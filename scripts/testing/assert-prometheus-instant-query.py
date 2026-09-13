#!/usr/bin/env python3
"""Assert a numeric Prometheus instant-query result without third-party modules."""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path


def fail(message: str) -> None:
    print(f"prometheus_assertion=FAIL reason={message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--operator", choices=("eq", "le", "lt", "ge", "gt"), required=True)
    parser.add_argument("--threshold", required=True, type=float)
    parser.add_argument("--expected-samples", type=int)
    parser.add_argument("--label", required=True)
    args = parser.parse_args()

    try:
        payload = json.loads(args.input.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"invalid_json:{exc}")

    if payload.get("status") != "success":
        fail("query_status_not_success")
    result = payload.get("data", {}).get("result")
    if not isinstance(result, list):
        fail("result_not_vector")
    if args.expected_samples is not None and len(result) != args.expected_samples:
        fail(f"{args.label}:samples={len(result)} expected={args.expected_samples}")
    if not result:
        fail(f"{args.label}:empty_result")

    values: list[float] = []
    for item in result:
        value = item.get("value") if isinstance(item, dict) else None
        if not isinstance(value, list) or len(value) != 2:
            fail(f"{args.label}:invalid_vector_value")
        try:
            parsed = float(value[1])
        except (TypeError, ValueError):
            fail(f"{args.label}:non_numeric_value")
        if not math.isfinite(parsed):
            fail(f"{args.label}:non_finite_value")
        values.append(parsed)

    comparisons = {
        "eq": lambda value: value == args.threshold,
        "le": lambda value: value <= args.threshold,
        "lt": lambda value: value < args.threshold,
        "ge": lambda value: value >= args.threshold,
        "gt": lambda value: value > args.threshold,
    }
    if not all(comparisons[args.operator](value) for value in values):
        fail(
            f"{args.label}:values={','.join(str(value) for value in values)} "
            f"operator={args.operator} threshold={args.threshold}"
        )
    print(
        f"prometheus_assertion=PASS label={args.label} "
        f"samples={len(values)} values={','.join(str(value) for value in values)}"
    )


if __name__ == "__main__":
    main()
