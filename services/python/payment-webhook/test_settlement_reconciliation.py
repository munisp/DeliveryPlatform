from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

from settlement_reconciliation import (  # noqa: E402
    ClassifiedRow,
    ManifestValidationError,
    classify_row,
    create_summary,
    exception_fingerprint,
    load_manifest,
    verify_artifact,
)


class SettlementReconciliationUnitTest(unittest.TestCase):
    def _manifest(self) -> dict[str, object]:
        row = {
            "source_line_no": 1,
            "source_record_key": "line-0001",
            "entry_kind": "collection",
            "provider_reference": "provider-reference-0001",
            "provider_final_state": "settled",
            "provider_final_status": "success",
            "currency": "NGN",
            "gross_minor": 120000,
            "fee_minor": 5000,
            "net_minor": 115000,
            "occurred_at": "2026-09-04T00:00:00Z",
            "settled_at": "2026-09-04T01:00:00Z",
            "normalized_metadata": {"settlement_cycle": "cycle-1"},
        }
        return {
            "merchant_account_id": "10000000-0000-4000-8000-000000000001",
            "provider_report_id": "provider-report-0001",
            "report_kind": "settlement_cycle",
            "period_start": "2026-09-04T00:00:00Z",
            "period_end": "2026-09-05T00:00:00Z",
            "retrieved_at": "2026-09-05T01:00:00Z",
            "source_object_ref": "restricted/settlement/provider-report-0001.json",
            "source_content_type": "application/json",
            "source_bytes": 512,
            "source_sha256": "a" * 64,
            "retrieval_actor": "settlement-worker",
            "rows": [row],
        }

    def _write_manifest(self, payload: dict[str, object]) -> Path:
        temporary = tempfile.NamedTemporaryFile(mode="w", suffix=".json", encoding="utf-8", delete=False)
        with temporary:
            json.dump(payload, temporary)
        return Path(temporary.name)

    def test_load_manifest_normalizes_deterministic_row_digest(self) -> None:
        path = self._write_manifest(self._manifest())
        try:
            manifest = load_manifest(path)
        finally:
            path.unlink(missing_ok=True)
        self.assertEqual(manifest.provider_report_id, "provider-report-0001")
        self.assertEqual(manifest.rows[0].net_minor, 115000)
        self.assertEqual(len(manifest.rows[0].source_row_sha256), 32)

    def test_artifact_integrity_requires_exact_manifest_digest_and_length(self) -> None:
        artifact_bytes = b'{"report":"settlement-cycle-1"}'
        payload = self._manifest()
        payload["source_bytes"] = len(artifact_bytes)
        payload["source_sha256"] = hashlib.sha256(artifact_bytes).hexdigest()
        manifest_path = self._write_manifest(payload)
        artifact = tempfile.NamedTemporaryFile(mode="wb", suffix=".json", delete=False)
        with artifact:
            artifact.write(artifact_bytes)
        artifact_path = Path(artifact.name)
        try:
            verify_artifact(artifact_path, load_manifest(manifest_path))
            artifact_path.write_bytes(artifact_bytes + b"x")
            with self.assertRaises(ManifestValidationError):
                verify_artifact(artifact_path, load_manifest(manifest_path))
        finally:
            manifest_path.unlink(missing_ok=True)
            artifact_path.unlink(missing_ok=True)

    def test_manifest_rejects_invalid_minor_unit_equation(self) -> None:
        payload = self._manifest()
        rows = payload["rows"]
        assert isinstance(rows, list)
        row = rows[0]
        assert isinstance(row, dict)
        row["net_minor"] = 1
        path = self._write_manifest(payload)
        try:
            with self.assertRaises(ManifestValidationError):
                load_manifest(path)
        finally:
            path.unlink(missing_ok=True)

    def test_manifest_rejects_nonmatching_supplied_row_digest(self) -> None:
        payload = self._manifest()
        rows = payload["rows"]
        assert isinstance(rows, list)
        row = rows[0]
        assert isinstance(row, dict)
        row["source_row_sha256"] = "b" * 64
        path = self._write_manifest(payload)
        try:
            with self.assertRaises(ManifestValidationError):
                load_manifest(path)
        finally:
            path.unlink(missing_ok=True)

    def test_classification_precedence_flags_ledger_imbalance_before_amount_difference(self) -> None:
        row = {
            "provider_row_id": "20000000-0000-4000-8000-000000000001",
            "provider_payment_id": "30000000-0000-4000-8000-000000000001",
            "payout_instruction_id": None,
            "entry_kind": "collection",
            "provider_reference": "provider-reference-0001",
            "reported_currency": "NGN",
            "expected_currency": "NGN",
            "reported_gross_minor": 119999,
            "expected_gross_minor": 120000,
            "reported_fee_minor": 5000,
            "expected_fee_minor": 5000,
            "reported_net_minor": 114999,
            "expected_net_minor": 115000,
            "provider_final_state": "settled",
            "provider_final_status": "success",
            "duplicate_reference_count": 1,
            "internal_state": "captured",
            "internal_occurred_at": datetime(2026, 9, 4, tzinfo=timezone.utc),
            "verification_evidenced": True,
            "ledger_balanced": False,
            "period_end": datetime(2026, 9, 5, tzinfo=timezone.utc),
            "settlement_grace": timedelta(hours=72),
            "unscoped_internal_present": False,
        }
        classified = classify_row(row, datetime(2026, 9, 5, tzinfo=timezone.utc))
        self.assertEqual(classified.classification, "ledger_imbalance")
        self.assertEqual(classified.severity, "critical")

    def test_provider_only_and_timing_difference_are_distinguished(self) -> None:
        provider_only = {
            "provider_row_id": "20000000-0000-4000-8000-000000000002",
            "provider_payment_id": None,
            "payout_instruction_id": None,
            "entry_kind": "collection",
            "provider_reference": "provider-reference-0002",
            "reported_currency": "NGN",
            "expected_currency": None,
            "reported_gross_minor": 120000,
            "expected_gross_minor": None,
            "reported_fee_minor": 5000,
            "expected_fee_minor": None,
            "reported_net_minor": 115000,
            "expected_net_minor": None,
            "provider_final_state": "settled",
            "provider_final_status": "success",
            "duplicate_reference_count": 1,
            "internal_state": None,
            "internal_occurred_at": None,
            "verification_evidenced": None,
            "ledger_balanced": None,
            "period_end": None,
            "settlement_grace": None,
            "unscoped_internal_present": False,
        }
        result = classify_row(provider_only, datetime(2026, 9, 5, tzinfo=timezone.utc))
        self.assertEqual(result.classification, "provider_only")

        timing_difference = {
            **provider_only,
            "provider_row_id": None,
            "provider_payment_id": "30000000-0000-4000-8000-000000000002",
            "reported_currency": None,
            "reported_gross_minor": None,
            "reported_fee_minor": None,
            "reported_net_minor": None,
            "expected_currency": "NGN",
            "expected_gross_minor": 120000,
            "expected_fee_minor": 5000,
            "expected_net_minor": 115000,
            "internal_state": "captured",
            "internal_occurred_at": datetime(2026, 9, 5, 0, 0, tzinfo=timezone.utc),
            "verification_evidenced": True,
            "ledger_balanced": True,
            "period_end": datetime(2026, 9, 5, tzinfo=timezone.utc),
            "settlement_grace": timedelta(hours=72),
        }
        result = classify_row(timing_difference, datetime(2026, 9, 5, 1, 0, tzinfo=timezone.utc))
        self.assertEqual(result.classification, "timing_difference")

    def test_exception_fingerprint_is_repeatable_and_summary_counts_unexplained(self) -> None:
        row = ClassifiedRow(
            provider_row_id="20000000-0000-4000-8000-000000000003",
            provider_payment_id="30000000-0000-4000-8000-000000000003",
            payout_instruction_id=None,
            entry_kind="collection",
            provider_reference="provider-reference-0003",
            classification="amount_mismatch",
            severity="critical",
            reported_currency="NGN",
            expected_currency="NGN",
            reported_gross_minor=119999,
            expected_gross_minor=120000,
            reported_fee_minor=5000,
            expected_fee_minor=5000,
            reported_net_minor=114999,
            expected_net_minor=115000,
            facts={"ledger_balanced": True},
        )
        first = exception_fingerprint("40000000-0000-4000-8000-000000000001", row)
        second = exception_fingerprint("40000000-0000-4000-8000-000000000001", row)
        self.assertEqual(first, second)
        self.assertEqual(first, hashlib.sha256(json.dumps({
            "reconciliation_run_id": "40000000-0000-4000-8000-000000000001",
            "entry_kind": "collection",
            "provider_reference": "provider-reference-0003",
            "classification": "amount_mismatch",
            "provider_row_id": "20000000-0000-4000-8000-000000000003",
            "provider_payment_id": "30000000-0000-4000-8000-000000000003",
            "payout_instruction_id": None,
            "reported_currency": "NGN",
            "expected_currency": "NGN",
            "reported_gross_minor": 119999,
            "expected_gross_minor": 120000,
            "reported_fee_minor": 5000,
            "expected_fee_minor": 5000,
            "reported_net_minor": 114999,
            "expected_net_minor": 115000,
            "facts": {"ledger_balanced": True},
        }, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("utf-8")).digest())
        summary = create_summary([row])
        self.assertEqual(summary["classification_counts"], {"amount_mismatch": 1})
        self.assertEqual(summary["unexplained_exception_count"], 1)


if __name__ == "__main__":
    unittest.main()
