"""Tests for the R16 market-economics report generator (pure logic + API)."""

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ["INTERNAL_SERVICE_TOKEN"] = "market-economics-test-token"

import main  # noqa: E402
import report  # noqa: E402

TOKEN = "market-economics-test-token"


def sample_inputs() -> dict:
    return {
        "market_id": "lagos-ng",
        "period": {"start": "2026-01-01", "end": "2026-12-31"},
        "trips": [
            {"gross_minor": 250_000, "take_minor": 50_000, "active_drivers": 100, "requests": 400},
            {"gross_minor": 180_000, "take_minor": 36_000, "active_drivers": 120, "requests": 380},
            {"gross_minor": 70_000, "take_minor": 14_000, "active_drivers": 150, "requests": 500},
        ],
        "published_take_rate_bps": 2000,
        "fare_floor_minor": 150_000,
    }


class GenerateMarketReportTests(unittest.TestCase):
    def test_report_shape_and_identity_fields(self):
        result = report.generate_market_report(sample_inputs())
        for key in (
            "market_id", "period", "trip_count", "gross_minor",
            "take_rate_actual_bps", "take_rate_published_bps",
            "floor_adherence_pct", "supply_index", "demand_index", "generated_at",
        ):
            self.assertIn(key, result)
        self.assertEqual(result["market_id"], "lagos-ng")
        self.assertEqual(result["period"], {"start": "2026-01-01", "end": "2026-12-31"})
        self.assertEqual(result["trip_count"], 3)

    def test_gross_minor_sums_trip_gross(self):
        result = report.generate_market_report(sample_inputs())
        self.assertEqual(result["gross_minor"], 250_000 + 180_000 + 70_000)
        self.assertIsInstance(result["gross_minor"], int)

    def test_take_rate_actual_bps_computed_from_aggregates(self):
        # total take 100_000 / total gross 500_000 = 2000 bps
        result = report.generate_market_report(sample_inputs())
        self.assertEqual(result["take_rate_actual_bps"], 2000)
        self.assertEqual(result["take_rate_published_bps"], 2000)

    def test_take_rate_actual_differs_from_published_when_platform_overcharges(self):
        inputs = sample_inputs()
        inputs["published_take_rate_bps"] = 1500
        result = report.generate_market_report(inputs)
        self.assertEqual(result["take_rate_actual_bps"], 2000)
        self.assertEqual(result["take_rate_published_bps"], 1500)

    def test_floor_adherence_pct_counts_trips_at_or_above_floor(self):
        # floor 150_000: trips 1 and 2 comply, trip 3 (70_000) does not.
        result = report.generate_market_report(sample_inputs())
        self.assertAlmostEqual(result["floor_adherence_pct"], 100.0 * 2 / 3, places=2)

    def test_supply_and_demand_index_against_period_average(self):
        # avg drivers = (100+120+150)/3 = 123.33; current (last trip) = 150
        # avg requests = (400+380+500)/3 = 426.67; current = 500
        result = report.generate_market_report(sample_inputs())
        self.assertAlmostEqual(result["supply_index"], 150 / (370 / 3), places=3)
        self.assertAlmostEqual(result["demand_index"], 500 / (1280 / 3), places=3)

    def test_empty_trips_is_safe_and_zeroed(self):
        inputs = sample_inputs()
        inputs["trips"] = []
        result = report.generate_market_report(inputs)
        self.assertEqual(result["trip_count"], 0)
        self.assertEqual(result["gross_minor"], 0)
        self.assertEqual(result["take_rate_actual_bps"], 0)
        self.assertEqual(result["floor_adherence_pct"], 0.0)
        self.assertEqual(result["supply_index"], 0.0)
        self.assertEqual(result["demand_index"], 0.0)

    def test_money_fields_reject_floats(self):
        inputs = sample_inputs()
        inputs["trips"][0]["gross_minor"] = 250_000.5
        with self.assertRaises(ValueError):
            report.generate_market_report(inputs)

    def test_negative_money_rejected(self):
        inputs = sample_inputs()
        inputs["fare_floor_minor"] = -1
        with self.assertRaises(ValueError):
            report.generate_market_report(inputs)

    def test_missing_required_input_rejected(self):
        for key in report.REQUIRED_INPUT_KEYS:
            inputs = sample_inputs()
            del inputs[key]
            with self.assertRaises(ValueError, msg=f"expected failure without {key}"):
                report.generate_market_report(inputs)

    def test_deterministic_except_generated_at(self):
        first = report.generate_market_report(sample_inputs())
        second = report.generate_market_report(sample_inputs())
        self.assertEqual(
            {k: v for k, v in first.items() if k != "generated_at"},
            {k: v for k, v in second.items() if k != "generated_at"},
        )

    def test_markdown_rendering_mentions_key_figures(self):
        generated = report.generate_market_report(sample_inputs())
        text = report.render_markdown(generated)
        self.assertIn("lagos-ng", text)
        self.assertIn("2000 bps", text)
        self.assertIn("matches published", text)
        self.assertIn("Fare-floor adherence", text)


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient

        cls.client = TestClient(main.app)

    def test_healthz_open(self):
        response = self.client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")

    def test_generate_requires_token(self):
        response = self.client.post("/reports/generate", json=sample_inputs())
        self.assertEqual(response.status_code, 401)

    def test_generate_roundtrip_and_latest(self):
        response = self.client.post(
            "/reports/generate",
            json=sample_inputs(),
            headers={"X-Internal-Service-Token": TOKEN},
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["report"]["market_id"], "lagos-ng")
        self.assertIn("Market Economics Report", body["markdown"])

        latest = self.client.get(
            "/reports/lagos-ng/latest",
            headers={"X-Internal-Service-Token": TOKEN},
        )
        self.assertEqual(latest.status_code, 200)
        self.assertEqual(latest.json(), body["report"])

    def test_latest_unknown_market_is_404(self):
        response = self.client.get(
            "/reports/no-such-market/latest",
            headers={"X-Internal-Service-Token": TOKEN},
        )
        self.assertEqual(response.status_code, 404)

    def test_latest_requires_token(self):
        response = self.client.get("/reports/lagos-ng/latest")
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
