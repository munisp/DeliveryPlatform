import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("offline_rl_policy_evaluator.py")
SPEC = importlib.util.spec_from_file_location("offline_rl_policy_evaluator", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class OfflinePolicyEvaluatorTests(unittest.TestCase):
    def valid_record(self, *, action="rank_nearest", reward=0.5, propensity=0.5):
        return {
            "decision_id": "decision-001",
            "domain": "dispatch_offer_ranking",
            "logged_action": action,
            "logged_propensity": propensity,
            "reward": reward,
            "candidate_actions": ["rank_nearest", "rank_best_eta"],
        }

    def test_allowlisted_operational_policy_can_only_recommend_shadow_evaluation(self):
        records = [
            MODULE.parse_record(self.valid_record()),
            MODULE.parse_record({**self.valid_record(action="rank_best_eta", reward=0.8), "decision_id": "decision-002"}),
        ]
        result = MODULE.evaluate_offline_policy(
            records,
            ("rank_nearest", "rank_best_eta"),
            minimum_records=2,
            minimum_uplift=-1.0,
        )
        self.assertTrue(result.approved_for_shadow)
        self.assertIn("shadow", result.reason)
        self.assertEqual(result.domain, "dispatch_offer_ranking")

    def test_payment_domain_is_rejected_fail_closed(self):
        raw = self.valid_record()
        raw["domain"] = "payment_routing"
        with self.assertRaisesRegex(MODULE.PolicyEvaluationError, "forbidden"):
            MODULE.parse_record(raw)

    def test_unknown_propensity_is_rejected_fail_closed(self):
        raw = self.valid_record(propensity=0.0)
        with self.assertRaisesRegex(MODULE.PolicyEvaluationError, "propensity"):
            MODULE.parse_record(raw)

    def test_duplicate_candidates_are_rejected(self):
        raw = self.valid_record()
        raw["candidate_actions"] = ["rank_nearest", "rank_nearest"]
        with self.assertRaisesRegex(MODULE.PolicyEvaluationError, "duplicates"):
            MODULE.parse_record(raw)

    def test_shadow_audit_records_hash_chain_and_confidence(self):
        record = MODULE.parse_record(self.valid_record())
        result = MODULE.evaluate_offline_policy(
            [record],
            ("rank_nearest",),
            minimum_records=1,
            minimum_uplift=-1.0,
        )
        with tempfile.TemporaryDirectory() as directory:
            audit_path = pathlib.Path(directory) / "shadow-audit.jsonl"
            first = MODULE.append_shadow_evaluation_audit(
                audit_path,
                evaluation_id="shadow-001",
                action_priority=("rank_nearest",),
                minimum_records=1,
                result=result,
            )
            second = MODULE.append_shadow_evaluation_audit(
                audit_path,
                evaluation_id="shadow-002",
                action_priority=("rank_nearest",),
                minimum_records=1,
                result=result,
            )
            self.assertEqual(second["previous_entry_hash"], first["entry_hash"])
            self.assertGreaterEqual(first["confidence_score"], 0.0)
            self.assertLessEqual(first["confidence_score"], 1.0)
            self.assertEqual(MODULE._validate_existing_audit_chain(audit_path), second["entry_hash"])
            audit_lines = audit_path.read_text(encoding="utf-8").splitlines()
            first_entry = json.loads(audit_lines[0])
            first_entry["reason"] = "tampered"
            audit_lines[0] = json.dumps(first_entry, sort_keys=True)
            audit_path.write_text("\n".join(audit_lines) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(MODULE.PolicyEvaluationError, "hash-chain"):
                MODULE._validate_existing_audit_chain(audit_path)


if __name__ == "__main__":
    unittest.main()
