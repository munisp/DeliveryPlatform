"""Tests for the pure integrity scoring module (R10).

Pure-logic tests import only scoring.py and run without FastAPI/pydantic.
Route tests import main.py (requires fastapi) and are skipped automatically
when the framework is unavailable.
"""

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import scoring  # noqa: E402

RULE_CREDIT_3 = {
    "id": "rule-credit-3",
    "role": "driver",
    "rule_key": "driver_streak_3_credit",
    "threshold_streak": 3,
    "reward_type": "credit",
    "amount_minor": 25000,
    "currency": "NGN",
    "active": True,
}
RULE_BADGE_5 = {
    "id": "rule-badge-5",
    "role": "driver",
    "rule_key": "driver_streak_5_badge",
    "threshold_streak": 5,
    "reward_type": "badge",
    "amount_minor": None,
    "currency": "NGN",
    "active": True,
}
RULE_RIDER_2 = {
    "id": "rule-rider-2",
    "role": "rider",
    "rule_key": "rider_streak_2_priority",
    "threshold_streak": 2,
    "reward_type": "priority",
    "amount_minor": None,
    "currency": "NGN",
    "active": True,
}


def driver_state(current=0, longest=0, last=None):
    return {
        "role": "driver",
        "current_streak": current,
        "longest_streak": longest,
        "last_event_at": last,
    }


def event(event_id, event_type, created_at="2026-07-01T00:00:00Z"):
    return {"id": event_id, "event_type": event_type, "created_at": created_at}


class DriverStreakTests(unittest.TestCase):
    def test_verified_completion_increments_streak_and_longest(self):
        result = scoring.evaluate_events(
            driver_state(current=1, longest=4),
            [],
            [event("e1", "verified_completion", "2026-07-02T10:00:00Z")],
        )
        state = result["new_state"]
        self.assertEqual(state["current_streak"], 2)
        self.assertEqual(state["longest_streak"], 4)
        self.assertEqual(state["last_event_at"], "2026-07-02T10:00:00Z")
        self.assertEqual(result["rewards_to_grant"], [])

    def test_longest_streak_tracks_new_peak(self):
        result = scoring.evaluate_events(
            driver_state(current=4, longest=4),
            [],
            [event("e1", "verified_completion")],
        )
        self.assertEqual(result["new_state"]["longest_streak"], 5)

    def test_verified_manifest_does_not_increment_driver(self):
        result = scoring.evaluate_events(
            driver_state(current=2),
            [],
            [event("e1", "verified_manifest")],
        )
        self.assertEqual(result["new_state"]["current_streak"], 2)

    def test_violation_resets_streak_and_counts_reset(self):
        result = scoring.evaluate_events(
            driver_state(current=7, longest=9),
            [],
            [event("e1", "violation")],
        )
        state = result["new_state"]
        self.assertEqual(state["current_streak"], 0)
        self.assertEqual(state["longest_streak"], 9)
        self.assertEqual(state["streak_resets"], 1)

    def test_violation_then_increment_rebuilds_from_zero(self):
        result = scoring.evaluate_events(
            driver_state(current=7),
            [],
            [event("e1", "violation"), event("e2", "verified_completion")],
        )
        self.assertEqual(result["new_state"]["current_streak"], 1)


class RewardRuleTests(unittest.TestCase):
    def test_reward_granted_exactly_at_threshold(self):
        result = scoring.evaluate_events(
            driver_state(current=2),
            [RULE_CREDIT_3],
            [event("evt-9", "verified_completion")],
        )
        rewards = result["rewards_to_grant"]
        self.assertEqual(len(rewards), 1)
        reward = rewards[0]
        self.assertEqual(reward["rule_id"], "rule-credit-3")
        self.assertEqual(reward["status"], "pending")
        self.assertEqual(reward["amount_minor"], 25000)
        self.assertEqual(reward["currency"], "NGN")
        self.assertEqual(reward["idempotency_key"], "evt-9:rule-credit-3")

    def test_no_reward_below_or_above_threshold(self):
        below = scoring.evaluate_events(
            driver_state(current=1), [RULE_CREDIT_3], [event("e1", "verified_completion")]
        )
        self.assertEqual(below["rewards_to_grant"], [])
        above = scoring.evaluate_events(
            driver_state(current=3), [RULE_CREDIT_3], [event("e2", "verified_completion")]
        )
        self.assertEqual(above["rewards_to_grant"], [])

    def test_multiple_thresholds_hit_in_one_batch(self):
        result = scoring.evaluate_events(
            driver_state(current=2),
            [RULE_CREDIT_3, RULE_BADGE_5],
            [event(f"e{i}", "verified_completion") for i in range(3)],
        )
        granted = [reward["rule_id"] for reward in result["rewards_to_grant"]]
        self.assertEqual(granted, ["rule-credit-3", "rule-badge-5"])
        keys = [reward["idempotency_key"] for reward in result["rewards_to_grant"]]
        self.assertEqual(keys, ["e0:rule-credit-3", "e2:rule-badge-5"])

    def test_inactive_rule_never_grants(self):
        inactive = dict(RULE_CREDIT_3, active=False)
        result = scoring.evaluate_events(
            driver_state(current=2), [inactive], [event("e1", "verified_completion")]
        )
        self.assertEqual(result["rewards_to_grant"], [])

    def test_wrong_role_rule_never_grants(self):
        result = scoring.evaluate_events(
            driver_state(current=1),
            [RULE_RIDER_2],
            [event("e1", "verified_completion"), event("e2", "verified_completion")],
        )
        self.assertEqual(result["rewards_to_grant"], [])

    def test_duplicate_event_id_grants_once(self):
        result = scoring.evaluate_events(
            driver_state(current=2),
            [RULE_CREDIT_3],
            [event("dup", "verified_completion"), event("dup", "verified_completion")],
        )
        self.assertEqual(result["new_state"]["current_streak"], 3)
        self.assertEqual(len(result["rewards_to_grant"]), 1)

    def test_violation_reset_to_zero_triggers_no_threshold(self):
        result = scoring.evaluate_events(
            driver_state(current=3),
            [RULE_CREDIT_3],
            [event("e1", "violation")],
        )
        self.assertEqual(result["rewards_to_grant"], [])


class RiderStreakTests(unittest.TestCase):
    def test_rider_verified_manifest_increments_and_grants(self):
        state = {
            "role": "rider",
            "current_streak": 1,
            "longest_streak": 1,
            "last_event_at": None,
        }
        result = scoring.evaluate_events(
            state, [RULE_RIDER_2], [event("r1", "verified_manifest")]
        )
        self.assertEqual(result["new_state"]["current_streak"], 2)
        rewards = result["rewards_to_grant"]
        self.assertEqual(len(rewards), 1)
        self.assertEqual(rewards[0]["reward_type"], "priority")
        self.assertIsNone(rewards[0]["amount_minor"])
        self.assertEqual(rewards[0]["idempotency_key"], "r1:rule-rider-2")

    def test_rider_verified_completion_does_not_increment(self):
        state = {"role": "rider", "current_streak": 3, "longest_streak": 3}
        result = scoring.evaluate_events(state, [], [event("r1", "verified_completion")])
        self.assertEqual(result["new_state"]["current_streak"], 3)


class ValidationTests(unittest.TestCase):
    def test_missing_role_rejected(self):
        with self.assertRaises(scoring.StreakEvaluationError):
            scoring.evaluate_events({"current_streak": 0}, [], [])

    def test_credit_rule_requires_amount_minor(self):
        bad = dict(RULE_CREDIT_3, amount_minor=None)
        with self.assertRaises(scoring.StreakEvaluationError):
            scoring.evaluate_events(driver_state(), [bad], [])

    def test_non_positive_threshold_rejected(self):
        bad = dict(RULE_CREDIT_3, threshold_streak=0)
        with self.assertRaises(scoring.StreakEvaluationError):
            scoring.evaluate_events(driver_state(), [bad], [])

    def test_deterministic_output(self):
        args = (
            driver_state(current=2),
            [RULE_CREDIT_3, RULE_BADGE_5],
            [event(f"e{i}", "verified_completion") for i in range(3)],
        )
        self.assertEqual(scoring.evaluate_events(*args), scoring.evaluate_events(*args))


try:
    os.environ.setdefault("INTERNAL_SERVICE_TOKEN", "incentives-test-token")
    import main  # noqa: E402

    HAS_FASTAPI = True
except ImportError:  # pragma: no cover - framework not installed
    HAS_FASTAPI = False


@unittest.skipUnless(HAS_FASTAPI, "fastapi not installed")
class RouteTests(unittest.TestCase):
    TOKEN = "incentives-test-token"

    def test_healthz_open(self):
        payload = main.healthz()
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["service"], "incentives-worker")

    def test_evaluate_route_requires_token(self):
        request = main.EvaluateRequest(
            streak_state={"role": "driver", "current_streak": 2},
            rules=[RULE_CREDIT_3],
            events=[event("e1", "verified_completion")],
        )
        with self.assertRaises(Exception) as raised:
            main.evaluate(request, "wrong-token")
        self.assertEqual(raised.exception.status_code, 401)

    def test_evaluate_route_happy_path(self):
        request = main.EvaluateRequest(
            streak_state={"role": "driver", "current_streak": 2},
            rules=[RULE_CREDIT_3],
            events=[event("evt-1", "verified_completion")],
        )
        response = main.evaluate(request, self.TOKEN)
        self.assertEqual(response.new_state["current_streak"], 3)
        self.assertEqual(len(response.rewards_to_grant), 1)
        self.assertEqual(response.rules_version, scoring.RULES_VERSION)

    def test_evaluate_route_rejects_zero_threshold_rule(self):
        with self.assertRaises(Exception):
            main.EvaluateRequest(
                streak_state={"role": "driver"},
                rules=[dict(RULE_CREDIT_3, threshold_streak=0)],
                events=[],
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
