"""Expose only manifest validity and freshness for governed Ray training.

The exporter does not expose source URIs, feature values, or signer keys. It
revalidates the exact canonical Ed25519 signature used by the training entrypoint
on every scrape so a stale or altered manifest cannot appear healthy.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def _canonical(document: dict[str, Any]) -> bytes:
    return json.dumps(
        {key: value for key, value in document.items() if key not in {"sha256", "signature_ed25519_base64"}},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _load_status() -> tuple[int, int]:
    path = Path(os.environ.get("LAKEHOUSE_TRAINING_MANIFEST_PATH", "").strip())
    key_json = os.environ.get("LAKEHOUSE_TRAINING_SIGNER_KEYS_JSON", "").strip()
    if not path.is_file() or not key_json:
        return 0, 0
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        keys = json.loads(key_json)
        if not isinstance(document, dict) or not isinstance(keys, dict):
            return 0, 0
        canonical = _canonical(document)
        declared = document.get("sha256")
        key_id = document.get("signing_key_id")
        signature = document.get("signature_ed25519_base64")
        if not isinstance(declared, str) or not hmac.compare_digest(declared, hashlib.sha256(canonical).hexdigest()):
            return 0, 0
        if not isinstance(key_id, str) or not isinstance(signature, str) or not isinstance(keys.get(key_id), str):
            return 0, 0
        public_key = base64.b64decode(keys[key_id], validate=True)
        signature_bytes = base64.b64decode(signature, validate=True)
        if len(public_key) != 32:
            return 0, 0
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature_bytes, canonical)
        generated_at = datetime.fromisoformat(str(document["generated_at"]).replace("Z", "+00:00"))
        if generated_at.tzinfo is None:
            return 0, 0
        age = max(0, int((datetime.now(UTC) - generated_at.astimezone(UTC)).total_seconds()))
        return 1, age
    except (KeyError, TypeError, ValueError, json.JSONDecodeError, InvalidSignature):
        return 0, 0


class MetricsHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/metrics":
            self.send_response(404)
            self.end_headers()
            return
        valid, age = _load_status()
        payload = (
            "# HELP deliveryplatform_lakehouse_training_manifest_valid Whether the mounted training manifest is complete, approved, digest-valid, and Ed25519-authenticated.\n"
            "# TYPE deliveryplatform_lakehouse_training_manifest_valid gauge\n"
            f"deliveryplatform_lakehouse_training_manifest_valid {valid}\n"
            "# HELP deliveryplatform_lakehouse_training_manifest_age_seconds Age of the generated-at value in a valid mounted training manifest.\n"
            "# TYPE deliveryplatform_lakehouse_training_manifest_age_seconds gauge\n"
            f"deliveryplatform_lakehouse_training_manifest_age_seconds {age}\n"
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def main() -> None:
    port = int(os.environ.get("LAKEHOUSE_TRAINING_MANIFEST_METRICS_PORT", "9470"))
    if not 1024 <= port <= 65535:
        raise ValueError("LAKEHOUSE_TRAINING_MANIFEST_METRICS_PORT must be between 1024 and 65535")
    HTTPServer(("0.0.0.0", port), MetricsHandler).serve_forever()


if __name__ == "__main__":
    main()
