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


    def test_manifest_object_syntax_required_fields_and_versions_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            records_path, manifest_path = self.write_export(directory, [self.raw_record()])
            manifest_path.write_text("[]", encoding="utf-8")
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "manifest must be a JSON object"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)

            manifest_path.write_text("{", encoding="utf-8")
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "manifest is invalid JSON"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)

            records_path, manifest_path = self.write_export(directory, [self.raw_record()])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            del manifest["source_system"]
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "missing required fields"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)

            records_path, manifest_path = self.write_export(directory, [self.raw_record()])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["manifest_schema_version"] = 2
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "unsupported manifest_schema_version"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)

            records_path, manifest_path = self.write_export(directory, [self.raw_record()])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["record_schema_version"] = 2
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "unsupported record_schema_version"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)

    def test_manifest_string_timestamp_digest_and_read_errors_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            records_path, manifest_path = self.write_export(directory, [self.raw_record()])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["domain"] = ""
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "manifest.domain must be a non-empty string"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)

            records_path, manifest_path = self.write_export(directory, [self.raw_record()])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["exported_at"] = "not-a-timestamp"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "ISO-8601 UTC"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)

            records_path, manifest_path = self.write_export(directory, [self.raw_record()])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["source_export_digest"] = "not-hex"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "SHA-256 hex digest"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)

            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "cannot read manifest"):
                PARSER.load_real_dispatch_export(records_path, pathlib.Path(directory))

    def test_records_file_syntax_and_read_errors_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            records_path, manifest_path = self.write_export(directory, [self.raw_record()])
            records_path.write_text("\n", encoding="utf-8")
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "blank records"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)

            records_path, manifest_path = self.write_export(directory, [self.raw_record()])
            records_path.write_text("{\n", encoding="utf-8")
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "invalid JSON"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)

            records_path, manifest_path = self.write_export(directory, [self.raw_record()])
            records_path.write_text("[]\n", encoding="utf-8")
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "must be a JSON object"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)

            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "cannot read records"):
                PARSER.load_real_dispatch_export(pathlib.Path(directory), manifest_path)

    def test_record_provenance_schema_digest_domain_and_empty_rejections(self):
        with tempfile.TemporaryDirectory() as directory:
            missing_provenance = self.raw_record()
            records_path, manifest_path = self.write_export(directory, [missing_provenance])
            delivered = json.loads(records_path.read_text(encoding="utf-8").strip())
            del delivered["event_time"]
            canonical = dict(delivered)
            canonical.pop("source_export_digest")
            digest = hashlib.sha256(
                (json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode("utf-8")
            ).hexdigest()
            delivered["source_export_digest"] = digest
            records_path.write_text(json.dumps(delivered) + "\n", encoding="utf-8")
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["source_export_digest"] = digest
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "missing provenance fields"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)

            invalid_schema = self.raw_record()
            invalid_schema["schema_version"] = 2
            records_path, manifest_path = self.write_export(directory, [invalid_schema])
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "unsupported record schema_version"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)

            records_path, manifest_path = self.write_export(directory, [self.raw_record()])
            delivered = json.loads(records_path.read_text(encoding="utf-8").strip())
            delivered["source_export_digest"] = "0" * 64
            records_path.write_text(json.dumps(delivered) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "source_export_digest does not match manifest"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)

            alternate_domain = self.raw_record()
            alternate_domain["domain"] = "notification_timing"
            records_path, manifest_path = self.write_export(directory, [alternate_domain])
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "domain does not match manifest"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)

            records_path, manifest_path = self.write_export(directory, [])
            with self.assertRaisesRegex(EVALUATOR.PolicyEvaluationError, "contains no records"):
                PARSER.load_real_dispatch_export(records_path, manifest_path)


if __name__ == "__main__":
    unittest.main()
