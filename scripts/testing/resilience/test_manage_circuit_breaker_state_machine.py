#!/usr/bin/env python3
from __future__ import annotations

import base64
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MANAGE = ROOT / "scripts/testing/resilience/manage-staging-resilience-circuit-breaker.sh"


class ManageCircuitBreakerStateMachineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory(prefix="managed-breaker-test-")
        self.path = Path(self.directory.name)
        self.state_path = self.path / "breaker.json"
        self.state_path.write_text(json.dumps({"resourceVersion": "11", "state": "open", "incident_id": "INCIDENT-TEST-001", "data": {}}), encoding="utf-8")
        self.bin_dir = self.path / "bin"
        self.bin_dir.mkdir()
        self.fake_kubectl = self.bin_dir / "kubectl"
        self.fake_kubectl.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                import json, os, sys
                from pathlib import Path

                state_path = Path(os.environ['FAKE_BREAKER_STATE'])
                state = json.loads(state_path.read_text())
                args = sys.argv[1:]
                if args == ['config', 'current-context']:
                    print('integration-test-context')
                    raise SystemExit(0)
                if args[:3] == ['get', 'namespace', 'resilience-test']:
                    print('non-production', end='')
                    raise SystemExit(0)
                if 'get' in args and 'configmap' in args:
                    print(f"{state['resourceVersion']}\\t{state['state']}\\t{state['incident_id']}", end='')
                    raise SystemExit(0)
                if 'patch' in args and 'configmap' in args:
                    if os.environ.get('FAKE_KUBECTL_CONFLICT') == '1':
                        raise SystemExit(1)
                    patch = json.loads(args[args.index('-p') + 1])
                    values = {'/metadata/resourceVersion': state['resourceVersion'], '/data/state': state['state'], '/data/incident_id': state['incident_id']}
                    for operation in patch:
                        if operation['op'] == 'test' and values.get(operation['path']) != operation['value']:
                            raise SystemExit(1)
                    for operation in patch:
                        if operation['op'] in ('add', 'replace'):
                            key = operation['path']
                            if key == '/data/state':
                                state['state'] = operation['value']
                                values[key] = operation['value']
                            elif key == '/data/incident_id':
                                state['incident_id'] = operation['value']
                                values[key] = operation['value']
                            elif key.startswith('/data/'):
                                state['data'][key.rsplit('/', 1)[-1]] = operation['value']
                    state['resourceVersion'] = str(int(state['resourceVersion']) + 1)
                    state_path.write_text(json.dumps(state), encoding='utf-8')
                    raise SystemExit(0)
                if 'delete' in args:
                    raise SystemExit(0)
                print('unexpected fake kubectl arguments: ' + repr(args), file=sys.stderr)
                raise SystemExit(2)
                """
            ),
            encoding="utf-8",
        )
        self.fake_kubectl.chmod(0o755)
        self.private_key = self.path / "approval-private.pem"
        self.public_key = self.path / "approval-public.pem"
        subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(self.private_key)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["openssl", "pkey", "-in", str(self.private_key), "-pubout", "-out", str(self.public_key)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def tearDown(self) -> None:
        self.directory.cleanup()

    def approval(self, action: str, evidence_id: str = "RECOVERY-TEST-001") -> Path:
        now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        payload = {
            "action": action,
            "approval_id": f"APPROVAL-{action}-001",
            "breaker_name": "resilience-validation-circuit-breaker",
            "environment": "test",
            "expires_at": (now + dt.timedelta(minutes=30)).isoformat().replace("+00:00", "Z"),
            "incident_id": "INCIDENT-TEST-001",
            "issued_at": now.isoformat().replace("+00:00", "Z"),
            "namespace": "resilience-test",
            "purpose": "resilience-circuit-breaker-recovery",
            "recovery_evidence_id": evidence_id,
        }
        payload_bytes = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        payload_path = self.path / "payload.json"
        signature_path = self.path / "signature.bin"
        payload_path.write_bytes(payload_bytes)
        subprocess.run(["openssl", "pkeyutl", "-sign", "-inkey", str(self.private_key), "-rawin", "-in", str(payload_path), "-out", str(signature_path)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        approval_path = self.path / f"{action}.json"
        approval_path.write_text(json.dumps({"key_id": "staging-recovery-ed25519-1", "payload_b64": base64.b64encode(payload_bytes).decode(), "signature_algorithm": "ed25519", "signature_b64": base64.b64encode(signature_path.read_bytes()).decode()}), encoding="utf-8")
        return approval_path

    def run_action(self, action: str, approval: Path | None = None, extra: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment.update(
            {
                "PATH": f"{self.bin_dir}:{environment['PATH']}",
                "FAKE_BREAKER_STATE": str(self.state_path),
                "RESILIENCE_TEST_CONTEXT": "integration-test-context",
                "TARGET_ENV": "test",
                "LOCAL_RESILIENCE_TEST": "true",
                "INCIDENT_ID": "INCIDENT-TEST-001",
                "CONFIRM_CIRCUIT_BREAKER_ACTION": f"{action}:INCIDENT-TEST-001",
                "RECOVERY_APPROVAL_PUBLIC_KEY_FILE": str(self.public_key),
                "RECOVERY_APPROVAL_KEY_ID": "staging-recovery-ed25519-1",
            }
        )
        if action == "half-open":
            environment.update({"HALF_OPEN_EVIDENCE_ID": "RECOVERY-TEST-001", "HALF_OPEN_APPROVAL_URL": approval.as_uri() if approval else ""})
        if action == "close":
            environment.update({"RECOVERY_EVIDENCE_ID": "RECOVERY-TEST-001", "CLOSE_APPROVAL_URL": approval.as_uri() if approval else ""})
        if extra:
            environment.update(extra)
        return subprocess.run(["bash", str(MANAGE), action], text=True, capture_output=True, env=environment, check=False)

    def state(self) -> dict[str, object]:
        return json.loads(self.state_path.read_text())

    def test_signed_half_open_then_signed_close(self) -> None:
        half_open = self.run_action("half-open", self.approval("half_open"))
        self.assertEqual(half_open.returncode, 0, half_open.stderr)
        after_half_open = self.state()
        self.assertEqual(after_half_open["state"], "half_open")
        self.assertEqual(after_half_open["data"]["half_open_evidence_id"], "RECOVERY-TEST-001")
        self.assertEqual(after_half_open["data"]["approval_id"], "APPROVAL-half_open-001")
        close = self.run_action("close", self.approval("close"))
        self.assertEqual(close.returncode, 0, close.stderr)
        after_close = self.state()
        self.assertEqual(after_close["state"], "closed")
        self.assertEqual(after_close["data"]["recovery_evidence_id"], "RECOVERY-TEST-001")
        self.assertEqual(after_close["data"]["approval_id"], "APPROVAL-close-001")

    def test_action_mismatch_refuses_half_open(self) -> None:
        result = self.run_action("half-open", self.approval("close"))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.state()["state"], "open")
        self.assertIn("signed recovery approval verification failed", result.stderr)

    def test_conflict_refuses_half_open_without_state_change(self) -> None:
        result = self.run_action("half-open", self.approval("half_open"), {"FAKE_KUBECTL_CONFLICT": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.state()["state"], "open")
        self.assertIn("optimistic transition open->half_open conflicted", result.stderr)


if __name__ == "__main__":
    unittest.main()
