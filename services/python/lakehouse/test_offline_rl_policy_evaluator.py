import contextlib
import importlib.util
import io
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
    def valid_record(self, *, decision_id="decision-001", action="rank_nearest", reward=0.5, propensity=0.5):
        return {
            "decision_id": decision_id,
            "domain": "dispatch_offer_ranking",
            "logged_action": action,
            "logged_propensity": propensity,
            "reward": reward,
            "candidate_actions": ["rank_nearest", "rank_best_eta"],
        }

    def write_jsonl(self, directory: str, *records: object) -> pathlib.Path:
        path = pathlib.Path(directory) / "records.jsonl"
        lines = [json.dumps(record) if not isinstance(record, str) else record for record in records]
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return path

    def test_allowlisted_operational_policy_can_only_recommend_shadow_evaluation(self):
        records = [
            MODULE.parse_record(self.valid_record()),
            MODULE.parse_record(self.valid_record(decision_id="decision-002", action="rank_best_eta", reward=0.8)),
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

    def test_parser_rejects_forbidden_unknown_and_missing_domains(self):
        payment = self.valid_record()
        payment["domain"] = "payment_routing"
        unknown = self.valid_record()
        unknown["domain"] = "pricing"
        missing = self.valid_record()
        del missing["reward"]
        for raw, message in ((payment, "forbidden"), (unknown, "allowlisted"), (missing, "missing")):
            with self.subTest(message=message), self.assertRaisesRegex(MODULE.PolicyEvaluationError, message):
                MODULE.parse_record(raw)

    def test_parser_rejects_invalid_numeric_and_action_fields(self):
        cases = []
        invalid_propensity = self.valid_record(propensity=True)
        cases.append((invalid_propensity, "numeric"))
        infinite_reward = self.valid_record(reward=float("inf"))
        cases.append((infinite_reward, "finite"))
        out_of_range_reward = self.valid_record(reward=1.1)
        cases.append((out_of_range_reward, "normalized"))
        no_candidates = self.valid_record()
        no_candidates["candidate_actions"] = []
        cases.append((no_candidates, "non-empty"))
        duplicate_candidates = self.valid_record()
        duplicate_candidates["candidate_actions"] = ["rank_nearest", "rank_nearest"]
        cases.append((duplicate_candidates, "duplicates"))
        missing_logged_action = self.valid_record(action="rank_unobserved")
        cases.append((missing_logged_action, "must occur"))
        for raw, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(MODULE.PolicyEvaluationError, message):
                MODULE.parse_record(raw)

    def test_load_records_rejects_invalid_json_non_object_duplicate_empty_and_mixed_domain(self):
        with tempfile.TemporaryDirectory() as directory:
            invalid = self.write_jsonl(directory, "not-json")
            with self.assertRaisesRegex(MODULE.PolicyEvaluationError, "invalid JSON"):
                MODULE.load_records(invalid)
            non_object = self.write_jsonl(directory, ["not", "an", "object"])
            with self.assertRaisesRegex(MODULE.PolicyEvaluationError, "JSON object"):
                MODULE.load_records(non_object)
            duplicate = self.write_jsonl(directory, self.valid_record(), self.valid_record())
            with self.assertRaisesRegex(MODULE.PolicyEvaluationError, "duplicate decision_id"):
                MODULE.load_records(duplicate)
            empty = self.write_jsonl(directory, "")
            with self.assertRaisesRegex(MODULE.PolicyEvaluationError, "no decision records"):
                MODULE.load_records(empty)
            other_domain = self.valid_record(decision_id="decision-002")
            other_domain["domain"] = "notification_timing"
            mixed = self.write_jsonl(directory, self.valid_record(), other_domain)
            with self.assertRaisesRegex(MODULE.PolicyEvaluationError, "exactly one"):
                MODULE.load_records(mixed)

    def test_load_records_accepts_blank_lines_and_proposed_action_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "records.jsonl"
            path.write_text("\n" + json.dumps(self.valid_record()) + "\n\n", encoding="utf-8")
            records = MODULE.load_records(path)
            self.assertEqual(len(records), 1)
            self.assertEqual(MODULE.proposed_action(records[0], ("not-present",)), "rank_nearest")

    def test_evaluation_rejects_invalid_configuration_and_mixed_domains(self):
        record = MODULE.parse_record(self.valid_record())
        other = MODULE.parse_record({**self.valid_record(decision_id="decision-002"), "domain": "notification_timing"})
        with self.assertRaisesRegex(MODULE.PolicyEvaluationError, "minimum_records"):
            MODULE.evaluate_offline_policy([record], ("rank_nearest",), minimum_records=0, minimum_uplift=0.0)
        with self.assertRaisesRegex(MODULE.PolicyEvaluationError, "action_priority"):
            MODULE.evaluate_offline_policy([record], (), minimum_records=1, minimum_uplift=0.0)
        with self.assertRaisesRegex(MODULE.PolicyEvaluationError, "mixed domains"):
            MODULE.evaluate_offline_policy([record, other], ("rank_nearest",), minimum_records=1, minimum_uplift=0.0)

    def test_evaluation_decision_gates_cover_insufficient_no_overlap_and_uplift(self):
        record = MODULE.parse_record(self.valid_record())
        insufficient = MODULE.evaluate_offline_policy([record], ("rank_nearest",), minimum_records=2, minimum_uplift=-1.0)
        self.assertIn("insufficient sample", insufficient.reason)
        no_overlap = MODULE.evaluate_offline_policy([record], ("rank_best_eta",), minimum_records=1, minimum_uplift=-1.0)
        self.assertIn("no proposed actions", no_overlap.reason)
        uplift = MODULE.evaluate_offline_policy([record], ("rank_nearest",), minimum_records=1, minimum_uplift=0.9)
        self.assertIn("insufficient estimated uplift", uplift.reason)
        self.assertGreater(MODULE.shadow_confidence(insufficient, 2), 0.0)
        self.assertEqual(MODULE.shadow_confidence(insufficient, 0), 0.0)

    def test_shadow_audit_records_hash_chain_confidence_and_tamper_rejection(self):
        record = MODULE.parse_record(self.valid_record())
        result = MODULE.evaluate_offline_policy([record], ("rank_nearest",), minimum_records=1, minimum_uplift=-1.0)
        with tempfile.TemporaryDirectory() as directory:
            audit_path = pathlib.Path(directory) / "shadow-audit.jsonl"
            first = MODULE.append_shadow_evaluation_audit(
                audit_path, evaluation_id="shadow-001", action_priority=("rank_nearest",), minimum_records=1, result=result
            )
            second = MODULE.append_shadow_evaluation_audit(
                audit_path, evaluation_id="shadow-002", action_priority=("rank_nearest",), minimum_records=1, result=result
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

    def test_audit_chain_rejects_blank_invalid_non_object_and_predecessor_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "audit.jsonl"
            for content, message in (("\n", "blank"), ("not-json\n", "invalid JSON"), ("[]\n", "object")):
                path.write_text(content, encoding="utf-8")
                with self.subTest(message=message), self.assertRaisesRegex(MODULE.PolicyEvaluationError, message):
                    MODULE._validate_existing_audit_chain(path)
            good = {
                "schema_version": 1,
                "previous_entry_hash": "incorrect",
            }
            good["entry_hash"] = MODULE._canonical_digest({k: v for k, v in good.items() if k != "entry_hash"})
            path.write_text(json.dumps(good) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(MODULE.PolicyEvaluationError, "predecessor"):
                MODULE._validate_existing_audit_chain(path)

    def test_main_reports_success_and_failure_with_audit_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            input_path = self.write_jsonl(directory, self.valid_record())
            audit_path = pathlib.Path(directory) / "audit.jsonl"
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                code = MODULE.main([
                    "--input", str(input_path),
                    "--action-priority", "rank_nearest",
                    "--minimum-records", "1",
                    "--minimum-uplift", "-1",
                    "--audit-log", str(audit_path),
                    "--evaluation-id", "cli-success",
                ])
            self.assertEqual(code, 0)
            self.assertIn("offline_rl_policy_evaluation", stdout.getvalue())
            self.assertTrue(audit_path.exists())
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                failure = MODULE.main([
                    "--input", str(pathlib.Path(directory) / "missing.jsonl"),
                    "--action-priority", "rank_nearest",
                    "--audit-log", str(audit_path),
                    "--evaluation-id", "cli-failure",
                ])
            self.assertEqual(failure, 2)
            self.assertIn("offline_rl_policy_evaluation=FAIL", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
