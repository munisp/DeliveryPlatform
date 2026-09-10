import hashlib
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).parent
EVALUATOR_PATH = ROOT / "offline_rl_policy_evaluator.py"
PARSER_PATH = ROOT / "real_dispatch_export_parser.py"

EVALUATOR_SPEC = importlib.util.spec_from_file_location("offline_rl_policy_evaluator", EVALUATOR_PATH)
assert EVALUATOR_SPEC and EVALUATOR_SPEC.loader
EVALUATOR = importlib.util.module_from_spec(EVALUATOR_SPEC)
sys.modules[EVALUATOR_SPEC.name] = EVALUATOR
EVALUATOR_SPEC.loader.exec_module(EVALUATOR)

PARSER_SPEC = importlib.util.spec_from_file_location("real_dispatch_export_parser", PARSER_PATH)
assert PARSER_SPEC and PARSER_SPEC.loader
PARSER = importlib.util.module_from_spec(PARSER_SPEC)
sys.modules[PARSER_SPEC.name] = PARSER
PARSER_SPEC.loader.exec_module(PARSER)


class RealDispatchExportParserTests(unittest.TestCase):
    def raw_record(self, *, decision_id="opaque-001"):
        return {
            "schema_version": 1,
            "decision_id": decision_id,
            "domain": "dispatch_offer_ranking",
            "logged_action": "rank_nearest",
            "logged_propensity": 0.5,
            "reward": 0.25,
            "candidate_actions": ["rank_nearest", "rank_best_eta"],
            "event_time": "2026-09-10T12:00:00Z",
        }

    def write_export(self, directory: str, records, *, mutate_manifest=None):
        canonical_lines = [
            json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n"
            for record in records
        ]
        source_digest = hashlib.sha256("".join(canonical_lines).encode("utf-8")).hexdigest()
        delivered_records = [dict(record, source_export_digest=source_digest) for record in records]
        records_path = pathlib.Path(directory) / "dispatch.jsonl"
        records_path.write_text(
            "".join(json.dumps(record, sort_keys=True) + "\n" for record in delivered_records), encoding="utf-8"
        )
        manifest = {
            "manifest_schema_version": 1,
            "record_schema_version": 1,
            "source_export_digest": source_digest,
            "domain": "dispatch_offer_ranking",
            "source_system": "append-only-dispatch-log",
            "exported_at": "2026-09-10T12:05:00+00:00",
            "reward_definition_version": "dispatch-v1",
            "propensity_logger_version": "policy-v1",
            "append_only_attested": True,
            "propensities_recorded_at_decision_time": True,
            "direct_identifiers_removed": True,
            "location_traces_removed": True,
        }
        if mutate_manifest:
            mutate_manifest(manifest)
        manifest_path = pathlib.Path(directory) / "dispatch.manifest.json"
        manifest_path.write_text(json.dumps(manifest, sort_keys=True), encoding="utf-8")
        return records_path, manifest_path

    def test_valid_export_loads(self):
        with tempfile.TemporaryDirectory() as directory:
            records_path, manifest_path = self.write_export(directory, [self.raw_record()])
            result = PARSER.load_real_dispatch_export(records_path, manifest_path)
            self.assertEqual(len(result.records), 1)
            self.assertEqual(result.records[0].decision_id, "opaque-001")
            self.assertEqual(result.manifest["source_system"], "append-only-dispatch-log")
            audit_path = pathlib.Path(directory) / "audit.jsonl"
            status = EVALUATOR.main(
                [
                    "--input", str(records_path),
                    "--provenance-manifest", str(manifest_path),
                    "--action-priority", "rank_nearest",
                    "--minimum-records", "1",
                    "--minimum-uplift", "-1",
                    "--audit-log", str(audit_path),
                    "--evaluation-id", "unit-real-export",
                ]
            )
            self.assertEqual(status, 0)
            self.assertTrue(audit_path.exists())

    def test_mutated_record_or_manifest_digest_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            records_path, manifest_path = self.write_export(directory, [self.raw_record()])
            delivered = json.loads(records_path.read_text(encoding="utf-8").strip())
            delivered["reward"] = 0.75
            records_path.write_text(json.dumps(delivered) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "digest"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)

            records_path, manifest_path = self.write_export(directory, [self.raw_record()])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["source_export_digest"] = "0" * 64
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "digest"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)

    def test_attestation_privacy_timestamp_and_duplicate_rejections(self):
        with tempfile.TemporaryDirectory() as directory:
            records_path, manifest_path = self.write_export(
                directory,
                [self.raw_record()],
                mutate_manifest=lambda manifest: manifest.update({"append_only_attested": False}),
            )
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "attestation"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)

            pii = self.raw_record()
            pii["driver_id"] = "direct-identifier"
            records_path, manifest_path = self.write_export(directory, [pii])
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "forbidden"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)

            invalid_time = self.raw_record()
            invalid_time["event_time"] = "2026-09-10T12:00:00"
            records_path, manifest_path = self.write_export(directory, [invalid_time])
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "UTC"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)

            records_path, manifest_path = self.write_export(directory, [self.raw_record(), self.raw_record()])
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "duplicate"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)


if __name__ == "__main__":
    unittest.main()
