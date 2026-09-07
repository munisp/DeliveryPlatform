#!/usr/bin/env python3
from __future__ import annotations

import base64
import datetime as dt
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
VERIFIER = ROOT / "scripts/testing/resilience/verify-signed-recovery-approval.py"


class SignedRecoveryApprovalTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory(prefix="signed-approval-test-")
        self.path = Path(self.directory.name)
        self.private_key = self.path / "approval-private.pem"
        self.public_key = self.path / "approval-public.pem"
        subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(self.private_key)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["openssl", "pkey", "-in", str(self.private_key), "-pubout", "-out", str(self.public_key)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def tearDown(self) -> None:
        self.directory.cleanup()

    def make_approval(self, *, action: str = "close", expires_at: dt.datetime | None = None, tamper: bool = False) -> Path:
        now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        expires = expires_at or now + dt.timedelta(minutes=30)
        payload = {
            "action": action,
            "approval_id": "APPROVAL-TEST-001",
            "breaker_name": "resilience-validation-circuit-breaker",
            "environment": "test",
            "expires_at": expires.isoformat().replace("+00:00", "Z"),
            "incident_id": "INCIDENT-TEST-001",
            "issued_at": now.isoformat().replace("+00:00", "Z"),
            "namespace": "resilience-test",
            "purpose": "resilience-circuit-breaker-recovery",
            "recovery_evidence_id": "RECOVERY-TEST-001",
        }
        payload_bytes = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        payload_path = self.path / "payload.json"
        signature_path = self.path / "signature.bin"
        payload_path.write_bytes(payload_bytes)
        subprocess.run(["openssl", "pkeyutl", "-sign", "-inkey", str(self.private_key), "-rawin", "-in", str(payload_path), "-out", str(signature_path)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        signature = bytearray(signature_path.read_bytes())
        if tamper:
            signature[0] ^= 0x01
        approval = {
            "key_id": "staging-recovery-ed25519-1",
            "payload_b64": base64.b64encode(payload_bytes).decode(),
            "signature_algorithm": "ed25519",
            "signature_b64": base64.b64encode(signature).decode(),
        }
        approval_path = self.path / f"approval-{action}.json"
        approval_path.write_text(json.dumps(approval), encoding="utf-8")
        return approval_path

    def verify(self, approval_path: Path, required_action: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(VERIFIER),
                "--url",
                approval_path.as_uri(),
                "--public-key",
                str(self.public_key),
                "--expected-key-id",
                "staging-recovery-ed25519-1",
                "--incident-id",
                "INCIDENT-TEST-001",
                "--recovery-evidence-id",
                "RECOVERY-TEST-001",
                "--environment",
                "test",
                "--namespace",
                "resilience-test",
                "--breaker-name",
                "resilience-validation-circuit-breaker",
                "--required-action",
                required_action,
                "--allow-local-file",
            ],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_valid_close_approval(self) -> None:
        result = self.verify(self.make_approval(action="close"), "close")
        self.assertEqual(result.returncode, 0, result.stderr)
        fields = result.stdout.strip().split("\t")
        self.assertEqual(fields[0], "APPROVAL-TEST-001")
        self.assertEqual(fields[1], "staging-recovery-ed25519-1")
        self.assertEqual(len(fields[2]), 64)

    def test_action_binding_rejects_half_open_approval_for_close(self) -> None:
        result = self.verify(self.make_approval(action="half_open"), "close")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("payload action does not match", result.stderr)

    def test_unexpected_key_id_is_rejected(self) -> None:
        approval_path = self.make_approval(action="close")
        approval = json.loads(approval_path.read_text(encoding="utf-8"))
        approval["key_id"] = "untrusted-recovery-key-1"
        approval_path.write_text(json.dumps(approval), encoding="utf-8")
        result = self.verify(approval_path, "close")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match the configured trusted key", result.stderr)

    def test_expired_approval_is_rejected(self) -> None:
        expired = dt.datetime.now(dt.timezone.utc).replace(microsecond=0) - dt.timedelta(minutes=1)
        result = self.verify(self.make_approval(expires_at=expired), "close")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("approval has expired", result.stderr)

    def test_tampered_signature_is_rejected(self) -> None:
        result = self.verify(self.make_approval(tamper=True), "close")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("signature verification failed", result.stderr)


if __name__ == "__main__":
    unittest.main()
