"""R16 published market economics — pure report-generation logic.

This module is deliberately free of any web framework imports so it can be
unit-tested without FastAPI and reused by batch jobs. All money values are
integer minor units (kobo); floats never carry money.

Report contract (SPEC Wave D2 / R16):

    generate_market_report({
        "market_id": str,
        "period": {"start": ISO date str, "end": ISO date str},
        "trips": [trip aggregate, ...],
        "published_take_rate_bps": int,
        "fare_floor_minor": int,
    }) -> {
        "market_id": str,
        "period": {"start": str, "end": str},
        "trip_count": int,
        "gross_minor": int,
        "take_rate_actual_bps": int,
        "take_rate_published_bps": int,
        "floor_adherence_pct": float,
        "supply_index": float,
        "demand_index": float,
        "generated_at": ISO-8601 UTC str,
    }

Trip aggregate schema (one record per completed trip in the period, or per
aggregate bucket — the math only relies on the fields below):

    gross_minor      int  total fare paid by the rider (minor units, >= 0)
    take_minor       int  platform take (commission + fees) for the trip (>= 0)
    active_drivers   int  drivers online in the trip's market window (>= 0)
    requests         int  ride requests (demand) in the trip's window (>= 0)

Index definitions (documented per SPEC):
    supply_index = active_drivers / max(1, avg_active_drivers)
    demand_index = requests        / max(1, avg_requests)
where active_drivers / requests are the most recent trip aggregate's values
(current snapshot) and the averages are the mean across all trip aggregates
in the period. An index of 1.0 therefore means "at the period average";
> 1.0 means supply/demand above the period average.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

REQUIRED_INPUT_KEYS = (
    "market_id",
    "period",
    "trips",
    "published_take_rate_bps",
    "fare_floor_minor",
)


def _non_negative_int(value: Any, field: str) -> int:
    """Coerce a trip field to a non-negative int; reject floats and bools."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{field} must be an integer (minor units), got {value!r}")
    if value < 0:
        raise ValueError(f"{field} must be non-negative, got {value}")
    return value


def _validate_inputs(inputs: dict[str, Any]) -> None:
    missing = [key for key in REQUIRED_INPUT_KEYS if key not in inputs]
    if missing:
        raise ValueError("missing required report inputs: " + ", ".join(missing))
    if not isinstance(inputs["market_id"], str) or not inputs["market_id"].strip():
        raise ValueError("market_id must be a non-empty string")
    period = inputs["period"]
    if not isinstance(period, dict) or not period.get("start") or not period.get("end"):
        raise ValueError("period must be an object with non-empty start and end")
    if not isinstance(inputs["trips"], list):
        raise ValueError("trips must be a list of trip aggregates")
    _non_negative_int(inputs["published_take_rate_bps"], "published_take_rate_bps")
    _non_negative_int(inputs["fare_floor_minor"], "fare_floor_minor")


def generate_market_report(inputs: dict[str, Any]) -> dict[str, Any]:
    """Generate the R16 per-market economics report from trip aggregates."""
    _validate_inputs(inputs)

    trips: list[dict[str, Any]] = inputs["trips"]
    fare_floor_minor: int = inputs["fare_floor_minor"]

    trip_count = len(trips)
    gross_minor = 0
    take_minor = 0
    floor_compliant = 0
    active_driver_samples: list[int] = []
    request_samples: list[int] = []

    for index, trip in enumerate(trips):
        if not isinstance(trip, dict):
            raise ValueError(f"trips[{index}] must be an object")
        gross = _non_negative_int(trip.get("gross_minor", 0), f"trips[{index}].gross_minor")
        take = _non_negative_int(trip.get("take_minor", 0), f"trips[{index}].take_minor")
        drivers = _non_negative_int(
            trip.get("active_drivers", 0), f"trips[{index}].active_drivers"
        )
        requests = _non_negative_int(trip.get("requests", 0), f"trips[{index}].requests")
        gross_minor += gross
        take_minor += take
        if gross >= fare_floor_minor:
            floor_compliant += 1
        active_driver_samples.append(drivers)
        request_samples.append(requests)

    # Actual take-rate in basis points, rounded to nearest integer. Zero gross
    # (no paid trips) reports 0 rather than dividing by zero.
    take_rate_actual_bps = (
        round(10_000 * take_minor / gross_minor) if gross_minor > 0 else 0
    )

    floor_adherence_pct = (
        round(100.0 * floor_compliant / trip_count, 2) if trip_count > 0 else 0.0
    )

    # supply_index / demand_index: most recent aggregate vs period average.
    current_active_drivers = active_driver_samples[-1] if active_driver_samples else 0
    current_requests = request_samples[-1] if request_samples else 0
    avg_active_drivers = (
        sum(active_driver_samples) / trip_count if trip_count > 0 else 0.0
    )
    avg_requests = sum(request_samples) / trip_count if trip_count > 0 else 0.0
    supply_index = round(current_active_drivers / max(1.0, avg_active_drivers), 4)
    demand_index = round(current_requests / max(1.0, avg_requests), 4)

    return {
        "market_id": inputs["market_id"],
        "period": {"start": inputs["period"]["start"], "end": inputs["period"]["end"]},
        "trip_count": trip_count,
        "gross_minor": gross_minor,
        "take_rate_actual_bps": take_rate_actual_bps,
        "take_rate_published_bps": inputs["published_take_rate_bps"],
        "floor_adherence_pct": floor_adherence_pct,
        "supply_index": supply_index,
        "demand_index": demand_index,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def render_markdown(report: dict[str, Any]) -> str:
    """Human-readable rendering of a machine-readable report (R16 dual format)."""
    gross_naira = report["gross_minor"] / 100
    take_delta = report["take_rate_actual_bps"] - report["take_rate_published_bps"]
    delta_note = "matches published" if take_delta == 0 else (
        f"{abs(take_delta)} bps {'above' if take_delta > 0 else 'below'} published"
    )
    lines = [
        f"# Market Economics Report — {report['market_id']}",
        "",
        f"Period: {report['period']['start']} to {report['period']['end']}",
        f"Generated: {report['generated_at']}",
        "",
        f"- Completed trips: {report['trip_count']}",
        f"- Gross fares: {gross_naira:,.2f} NGN ({report['gross_minor']} kobo)",
        f"- Actual take-rate: {report['take_rate_actual_bps']} bps "
        f"(published {report['take_rate_published_bps']} bps; {delta_note})",
        f"- Fare-floor adherence: {report['floor_adherence_pct']}% of trips",
        f"- Supply index: {report['supply_index']} (1.0 = period average)",
        f"- Demand index: {report['demand_index']} (1.0 = period average)",
    ]
    return "\n".join(lines) + "\n"
