import asyncio
import base64
import hashlib
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ["INTERNAL_SERVICE_TOKEN"] = "verification-test-token"
os.environ["VERIFICATION_SYNTHETIC_MODE"] = "true"
import main  # noqa: E402


class VerificationIntelligenceTests(unittest.TestCase):
    def test_document_digest_mismatch_is_rejected(self):
        body = b"synthetic identity document"
        with self.assertRaises(Exception) as raised:
            main.decode_and_verify(base64.b64encode(body).decode(), "0" * 64)
        self.assertEqual(raised.exception.status_code, 422)

    def test_synthetic_document_requires_manual_review(self):
        body = b"synthetic identity document"
        digest = hashlib.sha256(body).hexdigest()
        request = main.DocumentRequest(
            processor="paddleocr",
            evidence_kind="identity_document",
            content_type="image/jpeg",
            sha256_hex=digest,
            object_body_base64=base64.b64encode(body).decode(),
        )
        result = asyncio.run(main.process_document(request, "verification-test-token"))
        self.assertEqual(result.state, "manual_review")
        self.assertEqual(result.outcome_code, "document_extracted_review_required")
        self.assertEqual(result.output["input_sha256"], digest)

    def test_valid_td3_mrz_and_altered_check_digit_are_distinguished_as_review_artifacts(self):
        lines = [
            "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<",
            "L898902C36UTO7408122F1204159ZE184226B<<<<<10",
        ]
        valid = main.validate_td3_mrz(lines)
        self.assertTrue(valid["valid"])
        altered = list(lines)
        altered[1] = altered[1][:9] + "0" + altered[1][10:]
        invalid = main.validate_td3_mrz(altered)
        self.assertFalse(invalid["valid"])
        self.assertIn("mrz_document_number_checksum_invalid", invalid["failures"])

    def test_forensics_reports_bounded_image_artifacts_and_never_auto_approves(self):
        body = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9dQAAAABJRU5ErkJggg=="
        )
        digest = hashlib.sha256(body).hexdigest()
        request = main.DocumentRequest(
            processor="document_forensics",
            evidence_kind="identity_document",
            content_type="image/png",
            sha256_hex=digest,
            object_body_base64=base64.b64encode(body).decode(),
            capture_metadata={
                "mrz_lines": [
                    "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<",
                    "L898902C36UTO7408122F1204159ZE184226B<<<<<10",
                ]
            },
        )
        result = main.forensics_result(request, body)
        self.assertEqual(result.state, "manual_review")
        self.assertEqual(result.outcome_code, "document_forensics_review_required")
        self.assertTrue(result.output["image_artifacts"]["file_signature_matches_content_type"])
        self.assertTrue(result.output["mrz"]["valid"])

    def test_liveness_artifact_incomplete_routes_to_manual_review(self):
        request = main.LivenessRequest(
            challenge_id="challenge-0001",
            challenge_nonce="synthetic-liveness-nonce-value",
            expected_nonce_sha256="0" * 64,
            capture_sha256="a" * 64,
            frame_sha256=["a" * 64, "b" * 64, "c" * 64],
            captured_at_ms=100,
            expires_at_ms=50,
            device_attestation_ref="attestation-0001",
        )
        result = main.process_liveness(request, "verification-test-token")
        self.assertEqual(result.state, "manual_review")
        self.assertEqual(result.outcome_code, "liveness_artifact_incomplete_manual_review")


if __name__ == "__main__":
    unittest.main(verbosity=2)
