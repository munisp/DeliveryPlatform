"""Pure maintenance-network coverage planner (R11).

Drivers in Nigeria reported vehicles off-road with no income and no
maintenance support. This module plans which vetted maintenance providers
should cover which demand points (clusters of vehicles needing service) so
the maximum number of vehicles get back on the road:

* greedy coverage: vetted candidates first, then cheapest, then highest
  capacity — deterministic tie-breaks on provider id;
* each candidate covers the nearest uncovered demand points within
  ``max_travel_km`` (haversine, stdlib math only) up to its capacity;
* ``budget_minor`` (integer kobo, never float) optionally caps total
  contracted cost; unaffordable candidates are skipped.

No framework imports: this module must stay importable and testable without
FastAPI/pydantic installed.
"""

from __future__ import annotations

import math
from typing import Any

EARTH_RADIUS_KM = 6371.0088
DEFAULT_MAX_TRAVEL_KM = 10.0


class MaintenancePlanError(ValueError):
    """Raised when demand points or candidates are malformed."""


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in kilometres via the haversine formula."""
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = (
        math.sin(delta_phi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    )
    return 2.0 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def _require_number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise MaintenancePlanError(f"{field} must be a number")
    return float(value)


def _require_minor(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise MaintenancePlanError(f"{field} must be an integer number of minor units")
    if value < 0:
        raise MaintenancePlanError(f"{field} must be >= 0")
    return value


def _normalize_demand(demand_points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    points: list[dict[str, Any]] = []
    for index, raw in enumerate(demand_points):
        if not isinstance(raw, dict):
            raise MaintenancePlanError(f"demand_points[{index}] must be an object")
        point_id = raw.get("point_id", raw.get("id"))
        if point_id is None or str(point_id) == "":
            raise MaintenancePlanError(f"demand_points[{index}].point_id is required")
        lat = _require_number(raw.get("lat"), f"demand_points[{index}].lat")
        lon = _require_number(raw.get("lon"), f"demand_points[{index}].lon")
        if not -90.0 <= lat <= 90.0 or not -180.0 <= lon <= 180.0:
            raise MaintenancePlanError(f"demand_points[{index}] has out-of-range coordinates")
        vehicles = raw.get("vehicles", 1)
        if isinstance(vehicles, bool) or not isinstance(vehicles, int) or vehicles < 1:
            raise MaintenancePlanError(f"demand_points[{index}].vehicles must be an integer >= 1")
        points.append(
            {
                "point_id": str(point_id),
                "lat": lat,
                "lon": lon,
                "vehicles": vehicles,
                "remaining": vehicles,
            }
        )
    return points


def _normalize_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    providers: list[dict[str, Any]] = []
    for index, raw in enumerate(candidates):
        if not isinstance(raw, dict):
            raise MaintenancePlanError(f"candidates[{index}] must be an object")
        provider_id = raw.get("provider_id", raw.get("id"))
        if provider_id is None or str(provider_id) == "":
            raise MaintenancePlanError(f"candidates[{index}].provider_id is required")
        lat = _require_number(raw.get("lat"), f"candidates[{index}].lat")
        lon = _require_number(raw.get("lon"), f"candidates[{index}].lon")
        if not -90.0 <= lat <= 90.0 or not -180.0 <= lon <= 180.0:
            raise MaintenancePlanError(f"candidates[{index}] has out-of-range coordinates")
        capacity = raw.get("capacity", 0)
        if isinstance(capacity, bool) or not isinstance(capacity, int) or capacity < 0:
            raise MaintenancePlanError(f"candidates[{index}].capacity must be an integer >= 0")
        cost_minor = _require_minor(raw.get("cost_minor", 0), f"candidates[{index}].cost_minor")
        providers.append(
            {
                "provider_id": str(provider_id),
                "name": str(raw.get("name") or provider_id),
                "lat": lat,
                "lon": lon,
                "vetted": bool(raw.get("vetted", False)),
                "capacity": capacity,
                "cost_minor": cost_minor,
            }
        )
    return providers


def plan_maintenance_network(
    demand_points: list[dict[str, Any]],
    candidates: list[dict[str, Any]],
    max_travel_km: float = DEFAULT_MAX_TRAVEL_KM,
    budget_minor: int | None = None,
) -> dict[str, Any]:
    """Greedily assign maintenance providers to demand points.

    Parameters
    ----------
    demand_points:
        [{point_id, lat, lon, vehicles}] — vehicles counts default to 1.
    candidates:
        [{provider_id, name?, lat, lon, vetted?, capacity?, cost_minor?}].
    max_travel_km:
        Maximum provider-to-demand travel distance for coverage.
    budget_minor:
        Optional total budget in integer minor units (kobo); each selected
        candidate consumes its ``cost_minor`` once.

    Returns
    -------
    {"selected": [...], "coverage_pct": float, "uncovered": [...],
     "total_vehicles": int, "covered_vehicles": int,
     "budget_minor": int|None, "budget_spent_minor": int}
    """

    max_travel_km = _require_number(max_travel_km, "max_travel_km")
    if max_travel_km <= 0:
        raise MaintenancePlanError("max_travel_km must be > 0")
    if budget_minor is not None:
        budget_minor = _require_minor(budget_minor, "budget_minor")

    points = _normalize_demand(demand_points)
    providers = _normalize_candidates(candidates)
    total_vehicles = sum(point["vehicles"] for point in points)

    # Vetted partners first (real negotiated network), then cheapest contract,
    # then highest capacity; provider id makes ordering fully deterministic.
    ordered = sorted(
        providers,
        key=lambda provider: (
            not provider["vetted"],
            provider["cost_minor"],
            -provider["capacity"],
            provider["provider_id"],
        ),
    )

    budget_remaining = budget_minor
    selected: list[dict[str, Any]] = []
    for provider in ordered:
        if provider["capacity"] <= 0:
            continue
        if all(point["remaining"] == 0 for point in points):
            break
        in_range = []
        for point in points:
            if point["remaining"] == 0:
                continue
            distance = haversine_km(provider["lat"], provider["lon"], point["lat"], point["lon"])
            if distance <= max_travel_km:
                in_range.append((distance, point))
        if not in_range:
            continue
        if budget_remaining is not None and provider["cost_minor"] > budget_remaining:
            continue
        in_range.sort(key=lambda item: (item[0], item[1]["point_id"]))
        assigned: list[dict[str, Any]] = []
        covered = 0
        for distance, point in in_range:
            if covered >= provider["capacity"]:
                break
            take = min(point["remaining"], provider["capacity"] - covered)
            point["remaining"] -= take
            covered += take
            assigned.append(
                {
                    "point_id": point["point_id"],
                    "vehicles": take,
                    "distance_km": round(distance, 3),
                }
            )
        if covered == 0:
            continue
        selected.append(
            {
                "provider_id": provider["provider_id"],
                "name": provider["name"],
                "vetted": provider["vetted"],
                "cost_minor": provider["cost_minor"],
                "capacity": provider["capacity"],
                "vehicles_covered": covered,
                "assigned": assigned,
            }
        )
        if budget_remaining is not None:
            budget_remaining -= provider["cost_minor"]

    budget_spent_minor = sum(item["cost_minor"] for item in selected)
    covered_vehicles = total_vehicles - sum(point["remaining"] for point in points)

    uncovered: list[dict[str, Any]] = []
    for point in points:
        if point["remaining"] == 0:
            continue
        in_range_costs = [
            provider["cost_minor"]
            for provider in providers
            if provider["capacity"] > 0
            and haversine_km(provider["lat"], provider["lon"], point["lat"], point["lon"])
            <= max_travel_km
        ]
        if not in_range_costs:
            reason = "no_provider_in_range"
        elif budget_minor is not None and min(in_range_costs) > (
            budget_minor - budget_spent_minor
        ):
            reason = "budget_exhausted"
        else:
            reason = "capacity_exhausted"
        uncovered.append(
            {"point_id": point["point_id"], "vehicles": point["remaining"], "reason": reason}
        )

    coverage_pct = round(100.0 * covered_vehicles / total_vehicles, 2) if total_vehicles else 100.0
    return {
        "selected": selected,
        "coverage_pct": coverage_pct,
        "uncovered": uncovered,
        "total_vehicles": total_vehicles,
        "covered_vehicles": covered_vehicles,
        "budget_minor": budget_minor,
        "budget_spent_minor": budget_spent_minor,
    }
