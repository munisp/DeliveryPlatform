#!/usr/bin/env python3
"""Local-only integration harness for the resilience circuit-breaker receiver.

The harness starts synthetic HTTP endpoints bound to 127.0.0.1, builds the real Go
receiver, generates ephemeral TLS material, and verifies receiver metrics, failure
threshold escalation payloads, and fail-closed ConfigMap state. It never contacts a
Kubernetes cluster, Matrix, Wazuh, Alertmanager, or the public network.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[3]
RECEIVER_DIR = ROOT / "services/go/resilience-circuit-breaker-alert-receiver"
ALERT_TOKEN = "local-kind-resilience-webhook-token-0001"
SERVICE_TOKEN = "local-service-account-token"


class State:
    def __init__(self, failures: int) -> None:
        self.breaker = "closed"
        self.patch_failures_remaining = failures
        self.patch_calls = 0
        self.matrix_payloads: list[dict[str, Any]] = []
        self.wazuh_payloads: list[dict[str, Any]] = []
        self.lock = threading.Lock()


def make_kube_handler(state: State):
    class KubeHandler(BaseHTTPRequestHandler):
        def log_message(self, *_: object) -> None:
            return

        def _authorized(self) -> bool:
            return self.headers.get("Authorization") == f"Bearer {SERVICE_TOKEN}"

        def do_GET(self) -> None:
            if not self._authorized():
                self.send_error(401)
                return
            if not self.path.endswith("/configmaps/resilience-validation-circuit-breaker"):
                self.send_error(404)
                return
            with state.lock:
                body = {"metadata": {"resourceVersion": "1"}, "data": {"state": state.breaker}}
            self._json(200, body)

        def do_PATCH(self) -> None:
            if not self._authorized():
                self.send_error(401)
                return
            with state.lock:
                state.patch_calls += 1
                if state.patch_failures_remaining > 0:
                    state.patch_failures_remaining -= 1
                    self.send_error(500, "synthetic Kubernetes patch failure")
                    return
                state.breaker = "open"
            self._json(200, {"data": {"state": "open"}})

        def _json(self, status: int, body: dict[str, Any]) -> None:
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    return KubeHandler


def make_escalation_handler(sink: list[dict[str, Any]]):
    class EscalationHandler(BaseHTTPRequestHandler):
        def log_message(self, *_: object) -> None:
            return

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            try:
                body = json.loads(self.rfile.read(length))
            except json.JSONDecodeError:
                self.send_error(400)
                return
            sink.append(body)
            self.send_response(200)
            self.end_headers()

    return EscalationHandler


def start_server(handler: type[BaseHTTPRequestHandler]) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def http_post(url: str, payload: dict[str, Any], token: str | None = None, insecure_tls: bool = False) -> tuple[int, str]:
    data = json.dumps(payload).encode()
    request = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/json"})
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    context = ssl._create_unverified_context() if insecure_tls else None
    try:
        with urllib.request.urlopen(request, context=context, timeout=5) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode()


def http_get(url: str, insecure_tls: bool = False) -> tuple[int, str]:
    context = ssl._create_unverified_context() if insecure_tls else None
    with urllib.request.urlopen(url, context=context, timeout=5) as response:
        return response.status, response.read().decode()


def allowed_alert(status: str = "firing", severity: str = "critical") -> dict[str, Any]:
    return {
        "status": status,
        "alerts": [
            {
                "status": status,
                "fingerprint": "local-harness-fingerprint",
                "labels": {
                    "alertname": "ResilienceInvariantProbeFailed",
                    "severity": severity,
                    "namespace": "resilience-test",
                    "circuit_breaker": "open",
                    "resilience.delivery-platform.io/environment": "non-production",
                },
            }
        ],
    }


def assertion(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--patch-failures", type=int, default=3)
    args = parser.parse_args()
    if args.patch_failures != 3:
        raise SystemExit("this fail-closed validation requires exactly three synthetic patch failures")
    if not shutil.which("openssl"):
        raise SystemExit("openssl is required to create ephemeral local TLS material")

    state = State(args.patch_failures)
    kube = start_server(make_kube_handler(state))
    matrix = start_server(make_escalation_handler(state.matrix_payloads))
    wazuh = start_server(make_escalation_handler(state.wazuh_payloads))
    receiver: subprocess.Popen[str] | None = None
    output: list[str] = []
    try:
        with tempfile.TemporaryDirectory(prefix="resilience-local-") as temp_dir:
            temp = pathlib.Path(temp_dir)
            binary = temp / "receiver"
            cert = temp / "tls.crt"
            key = temp / "tls.key"
            token_file = temp / "service-account-token"
            token_file.write_text(SERVICE_TOKEN)
            subprocess.run(["go", "build", "-o", str(binary), "."], cwd=RECEIVER_DIR, check=True)
            subprocess.run(
                ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", str(key), "-out", str(cert)],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            env = os.environ | {
                "LOCAL_RESILIENCE_TEST": "true",
                "ALERTMANAGER_WEBHOOK_TOKEN": ALERT_TOKEN,
                "KUBERNETES_API_SCHEME": "http",
                "KUBERNETES_SERVICE_HOST": f"127.0.0.1:{kube.server_port}",
                "SERVICE_ACCOUNT_TOKEN_FILE": str(token_file),
                "TLS_CERT_FILE": str(cert),
                "TLS_KEY_FILE": str(key),
            }
            receiver = subprocess.Popen([str(binary)], cwd=RECEIVER_DIR, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            receiver_url = "https://127.0.0.1:8443"
            for _ in range(40):
                try:
                    status, _ = http_get(receiver_url + "/readyz", insecure_tls=True)
                    if status == 200:
                        break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("receiver did not become ready")

            for attempt in range(3):
                status, _ = http_post(receiver_url + "/v1/alertmanager/open", allowed_alert(), ALERT_TOKEN, insecure_tls=True)
                assertion(status == 503, f"synthetic failure attempt {attempt + 1} returned {status}")
            status, metrics = http_get(receiver_url + "/metrics", insecure_tls=True)
            assertion(status == 200, "metrics endpoint was unavailable")
            expected_metric = 'resilience_circuit_breaker_patch_failures_total{alertname="ResilienceInvariantProbeFailed",failure_class="kubernetes_api"} 3'
            assertion(expected_metric in metrics, "three-failure counter was not emitted")
            assertion(state.breaker == "closed", "breaker changed despite all synthetic patch failures")

            escalation = {
                "status": "firing",
                "alerts": [{"status": "firing", "labels": {"alertname": "ResilienceCircuitBreakerPatchFailureEscalation", "severity": "critical", "namespace": "resilience-test"}, "annotations": {"summary": "redacted local escalation"}}],
            }
            for endpoint in (f"http://127.0.0.1:{matrix.server_port}/v1/alerts", f"http://127.0.0.1:{wazuh.server_port}/v1/alerts"):
                status, _ = http_post(endpoint, escalation)
                assertion(status == 200, f"mock escalation endpoint returned {status}")
            assertion(len(state.matrix_payloads) == 1 and len(state.wazuh_payloads) == 1, "both escalation paths must receive exactly one redacted event")

            status, _ = http_post(receiver_url + "/v1/alertmanager/open", allowed_alert(), ALERT_TOKEN, insecure_tls=True)
            assertion(status == 202, f"recovery alert returned {status}")
            assertion(state.breaker == "open", "breaker did not open after mock Kubernetes recovery")
            status, _ = http_post(receiver_url + "/v1/alertmanager/open", allowed_alert(status="resolved"), ALERT_TOKEN, insecure_tls=True)
            assertion(status == 400, "resolved alert was not rejected")
            status, _ = http_post(receiver_url + "/v1/alertmanager/open", allowed_alert(severity="warning"), ALERT_TOKEN, insecure_tls=True)
            assertion(status == 403, "warning alert was not rejected")
            _, metrics = http_get(receiver_url + "/metrics", insecure_tls=True)
            assertion('resilience_circuit_breaker_patch_success_total{alertname="ResilienceInvariantProbeFailed"} 1' in metrics, "success counter was not emitted")
            assertion('\nresilience_circuit_breaker_open_idempotent_total{' not in metrics, "unexpected idempotent counter sample in this test")
            print("LOCAL_RECEIVER_ESCALATION_HARNESS=PASS")
            print(f"synthetic_patch_failures=3 matrix_events={len(state.matrix_payloads)} wazuh_events={len(state.wazuh_payloads)} breaker_state={state.breaker}")
    finally:
        if receiver is not None:
            receiver.terminate()
            try:
                stdout, _ = receiver.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                receiver.kill()
                stdout, _ = receiver.communicate(timeout=5)
            output.extend(stdout.splitlines())
        kube.shutdown()
        matrix.shutdown()
        wazuh.shutdown()
        if output:
            print("receiver_log_events=" + str(len(output)), file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"LOCAL_RECEIVER_ESCALATION_HARNESS=FAIL error={exc}", file=sys.stderr)
        raise
