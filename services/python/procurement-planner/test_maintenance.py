"""Tests for the pure maintenance network planner (R11).

Pure-logic tests import only maintenance.py and run without FastAPI/pydantic.
Route tests import main.py (requires fastapi) with a stubbed execution store
and are skipped automatically when the framework is unavailable.
"""

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import maintenance  # noqa: E402

# Lagos-ish coordinates for realistic fixtures.
LAGOS_ISLAND = (6.4541, 3.3947)
IKEJA = (6.6018, 3.3515)
LEKKI = (6.4474, 3.4723)
ABUJA = (9.0765, 7.3986)


def point(point_id, lat, lon, vehicles=1):
    return {"point_id": point_id, "lat": lat, "lon": lon, "vehicles": vehicles}


def provider(provider_id, lat, lon, vetted=False, capacity=0, cost_minor=0, name=None):
    return {
        "provider_id": provider_id,
        "name": name or provider_id,
        "lat": lat,
        "lon": lon,
        "vetted": vetted,
        "capacity": capacity,
        "cost_minor": cost_minor,
    }


class HaversineTests(unittest.TestCase):
    def test_same_point_is_zero(self):
        self.assertEqual(maintenance.haversine_km(*LAGOS_ISLAND, *LAGOS_ISLAND), 0.0)

    def test_lagos_to_abuja_is_plausible(self):
        distance = maintenance.haversine_km(*LAGOS_ISLAND, *ABUJA)
        self.assertGreater(distance, 500.0)
        self.assertLess(distance, 600.0)

    def test_symmetry(self):
        self.assertAlmostEqual(
            maintenance.haversine_km(*LAGOS_ISLAND, *IKEJA),
            maintenance.haversine_km(*IKEJA, *LAGOS_ISLAND),
        )


class CoverageTests(unittest.TestCase):
    def test_vetted_provider_preferred_over_cheaper_unvetted(self):
        plan = maintenance.plan_maintenance_network(
            [point("d1", *LAGOS_ISLAND)],
            [
                provider("cheap-unvetted", *LAGOS_ISLAND, vetted=False, capacity=5, cost_minor=100),
                provider("vetted-partner", *LAGOS_ISLAND, vetted=True, capacity=5, cost_minor=900),
            ],
        )
        self.assertEqual(plan["selected"][0]["provider_id"], "vetted-partner")
        self.assertEqual(plan["coverage_pct"], 100.0)

    def test_vehicles_beyond_capacity_left_for_next_provider(self):
        plan = maintenance.plan_maintenance_network(
            [point("d1", *LAGOS_ISLAND, vehicles=5)],
            [
                provider("p1", *LAGOS_ISLAND, vetted=True, capacity=3),
                provider("p2", *LAGOS_ISLAND, vetted=True, capacity=3),
            ],
        )
        self.assertEqual(plan["covered_vehicles"], 5)
        self.assertEqual(len(plan["selected"]), 2)
        self.assertEqual(plan["selected"][0]["vehicles_covered"], 3)
        self.assertEqual(plan["selected"][1]["vehicles_covered"], 2)

    def test_out_of_range_point_is_uncovered_with_reason(self):
        plan = maintenance.plan_maintenance_network(
            [point("far", *ABUJA, vehicles=2)],
            [provider("p1", *LAGOS_ISLAND, vetted=True, capacity=10)],
            max_travel_km=10.0,
        )
        self.assertEqual(plan["coverage_pct"], 0.0)
        self.assertEqual(plan["uncovered"], [
            {"point_id": "far", "vehicles": 2, "reason": "no_provider_in_range"}
        ])

    def test_capacity_exhausted_reason_when_provider_in_range_but_full(self):
        plan = maintenance.plan_maintenance_network(
            [point("d1", *LAGOS_ISLAND, vehicles=4)],
            [provider("p1", *LAGOS_ISLAND, vetted=True, capacity=1)],
        )
        self.assertEqual(plan["covered_vehicles"], 1)
        self.assertEqual(plan["uncovered"][0]["reason"], "capacity_exhausted")
        self.assertEqual(plan["uncovered"][0]["vehicles"], 3)

    def test_nearest_point_assigned_first(self):
        plan = maintenance.plan_maintenance_network(
            [
                point("near", *LAGOS_ISLAND),
                point("far", *LEKKI),
            ],
            [provider("p1", *LAGOS_ISLAND, vetted=True, capacity=1)],
            max_travel_km=50.0,
        )
        self.assertEqual(plan["selected"][0]["assigned"][0]["point_id"], "near")

    def test_budget_skips_unaffordable_provider(self):
        plan = maintenance.plan_maintenance_network(
            [point("d1", *LAGOS_ISLAND), point("d2", *IKEJA)],
            [
                provider("p1", *LAGOS_ISLAND, vetted=True, capacity=1, cost_minor=40000),
                provider("p2", *IKEJA, vetted=True, capacity=1, cost_minor=40000),
            ],
            max_travel_km=50.0,
            budget_minor=40000,
        )
        self.assertEqual(plan["budget_spent_minor"], 40000)
        self.assertEqual(plan["covered_vehicles"], 1)
        self.assertEqual(plan["uncovered"][0]["reason"], "budget_exhausted")
        # Money stays integer minor units end to end.
        self.assertIsInstance(plan["budget_spent_minor"], int)

    def test_partial_coverage_pct_uses_vehicle_counts(self):
        plan = maintenance.plan_maintenance_network(
            [point("d1", *LAGOS_ISLAND, vehicles=3), point("d2", *ABUJA, vehicles=1)],
            [provider("p1", *LAGOS_ISLAND, vetted=True, capacity=3)],
            max_travel_km=10.0,
        )
        self.assertEqual(plan["coverage_pct"], 75.0)

    def test_assignment_is_deterministic(self):
        demand = [point("d1", *LAGOS_ISLAND, vehicles=2), point("d2", *IKEJA, vehicles=2)]
        candidates = [
            provider("p1", *LAGOS_ISLAND, vetted=True, capacity=2, cost_minor=100),
            provider("p2", *IKEJA, vetted=False, capacity=2, cost_minor=50),
        ]
        first = maintenance.plan_maintenance_network(demand, candidates, max_travel_km=50.0)
        second = maintenance.plan_maintenance_network(demand, candidates, max_travel_km=50.0)
        self.assertEqual(first, second)

    def test_empty_demand_reports_full_coverage(self):
        plan = maintenance.plan_maintenance_network(
            [], [provider("p1", *LAGOS_ISLAND, vetted=True, capacity=5)]
        )
        self.assertEqual(plan["coverage_pct"], 100.0)
        self.assertEqual(plan["selected"], [])


class ValidationTests(unittest.TestCase):
    def test_float_cost_minor_rejected(self):
        with self.assertRaises(maintenance.MaintenancePlanError):
            maintenance.plan_maintenance_network(
                [point("d1", *LAGOS_ISLAND)],
                [provider("p1", *LAGOS_ISLAND, capacity=1, cost_minor=10.5)],
            )

    def test_invalid_coordinates_rejected(self):
        with self.assertRaises(maintenance.MaintenancePlanError):
            maintenance.plan_maintenance_network(
                [point("d1", 91.0, 3.0)],
                [provider("p1", *LAGOS_ISLAND, capacity=1)],
            )

    def test_non_positive_travel_radius_rejected(self):
        with self.assertRaises(maintenance.MaintenancePlanError):
            maintenance.plan_maintenance_network(
                [point("d1", *LAGOS_ISLAND)],
                [provider("p1", *LAGOS_ISLAND, capacity=1)],
                max_travel_km=0,
            )


try:
    import psycopg  # noqa: F401
except ImportError:
    # psycopg is only needed by DurableRunStore's DB calls, which the route
    # tests stub out; provide an import-time stand-in so main.py loads.
    import types

    _psycopg_stub = types.ModuleType("psycopg")

    def _psycopg_unavailable(*args, **kwargs):  # pragma: no cover
        raise RuntimeError("psycopg is not installed in this test environment")

    _psycopg_stub.connect = _psycopg_unavailable
    sys.modules["psycopg"] = _psycopg_stub

try:
    os.environ.setdefault("INTERNAL_SERVICE_TOKEN", "procurement-test-token")
    os.environ.setdefault("DATABASE_URL", "postgres://unused-in-tests")
    import main  # noqa: E402

    HAS_FASTAPI = True
except ImportError:  # pragma: no cover - framework not installed
    HAS_FASTAPI = False


@unittest.skipUnless(HAS_FASTAPI, "fastapi not installed")
class RouteTests(unittest.TestCase):
    TOKEN = "procurement-test-token"

    def setUp(self):
        # Route tests must not touch Postgres: stub the durable run store.
        class _StubStore:
            def record(self, *args, **kwargs):
                return None

        self._original_store = main.execution_store
        main.execution_store = _StubStore()

    def tearDown(self):
        main.execution_store = self._original_store

    def _request(self):
        return main.MaintenancePlanRequest(
            city="Lagos",
            demand_points=[point("d1", *LAGOS_ISLAND, vehicles=2)],
            candidates=[provider("p1", *LAGOS_ISLAND, vetted=True, capacity=5, cost_minor=1000)],
        )

    def test_healthz_open(self):
        payload = main.healthz()
        self.assertEqual(payload["status"], "ok")
        self.assertIn("maintenance-network", payload["modes"])

    def test_maintenance_plan_requires_token(self):
        with self.assertRaises(Exception) as raised:
            main.maintenance_plan(self._request(), "wrong-token")
        self.assertEqual(raised.exception.status_code, 401)

    def test_maintenance_plan_happy_path(self):
        response = main.maintenance_plan(self._request(), self.TOKEN)
        self.assertEqual(response.coverage_pct, 100.0)
        self.assertEqual(response.selected[0]["provider_id"], "p1")
        self.assertEqual(response.covered_vehicles, 2)
        self.assertEqual(response.budget_spent_minor, 1000)


if __name__ == "__main__":
    unittest.main(verbosity=2)
