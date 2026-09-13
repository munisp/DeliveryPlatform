"""Create an Ed25519-signed lakehouse training manifest.

Run this only in the governed export environment. The trainer receives only the
public-key allowlist and will reject unsigned, altered, or unapproved manifests.
The private signing key is read from an environment variable and is never written
to the output manifest, logs, or command-line arguments.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def _canonical_manifest_payload(document: dict[str, Any]) -> bytes:
    payload = {
        key: value
        for key, value in document.items()
        if key not in {"sha256", "signature_ed25519_base64"}
    }
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _private_key_from_environment() -> Ed25519PrivateKey:
    encoded = os.environ.get("LAKEHOUSE_TRAINING_SIGNER_PRIVATE_KEY_BASE64", "").strip()
    if not encoded:
        raise ValueError("LAKEHOUSE_TRAINING_SIGNER_PRIVATE_KEY_BASE64 is required")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except ValueError as error:
        raise ValueError("private key must be base64-encoded") from error
    if len(raw) != 32:
        raise ValueError("Ed25519 private key must be exactly 32 bytes")
    return Ed25519PrivateKey.from_private_bytes(raw)


def main() -> None:
    parser = argparse.ArgumentParser(description="Sign a governed lakehouse training manifest")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--signing-key-id", required=True)
    args = parser.parse_args()

    if not args.signing_key_id or len(args.signing_key_id) > 128:
        raise ValueError("signing key id is invalid")
    try:
        document = json.loads(args.input.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError("input must be valid JSON") from error
    if not isinstance(document, dict):
        raise ValueError("input manifest must be a JSON object")
    if "sha256" in document or "signature_ed25519_base64" in document:
        raise ValueError("input manifest must not already contain signature fields")

    document["signing_key_id"] = args.signing_key_id
    canonical = _canonical_manifest_payload(document)
    document["sha256"] = hashlib.sha256(canonical).hexdigest()
    document["signature_ed25519_base64"] = base64.b64encode(
        _private_key_from_environment().sign(canonical)
    ).decode("ascii")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
