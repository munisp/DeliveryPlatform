#!/usr/bin/env python3
"""Verify a signed, canonical recovery approval before a breaker close action.

The approval envelope must contain a base64-encoded canonical JSON payload and an
Ed25519 signature over those exact payload bytes. The verifier prints one
machine-readable tab-delimited line and never prints the signature, payload, or
secret material.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import re
import ssl
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$")
MAX_APPROVAL_BYTES = 64 * 1024
MAX_APPROVAL_TTL = dt.timedelta(hours=24)
FUTURE_SKEW = dt.timedelta(minutes=5)


def fail(message: str) -> None:
    print(f"recovery approval verification refused: {message}", file=sys.stderr)
    raise SystemExit(1)


def require_identifier(name: str, value: str) -> None:
    if not IDENTIFIER.fullmatch(value):
        fail(f"{name} must be 3-81 characters using letters, digits, dot, underscore, or hyphen")


def parse_time(name: str, value: Any) -> dt.datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        fail(f"payload {name} must be an RFC3339 UTC timestamp ending in Z")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        fail(f"payload {name} is invalid")
    if parsed.tzinfo is None:
        fail(f"payload {name} must include UTC timezone")
    return parsed.astimezone(dt.timezone.utc)


def read_approval(url: str, ca_file: Path | None, allow_local_file: bool) -> bytes:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme == "file":
        if not allow_local_file:
            fail("file approval URLs are allowed only with --allow-local-file for deterministic tests")
        if parsed.netloc not in ("", "localhost"):
            fail("file approval URL must not specify a remote host")
        try:
            return Path(urllib.request.url2pathname(parsed.path)).read_bytes()
        except OSError as exc:
            fail(f"cannot read local approval artifact: {exc}")
    if parsed.scheme != "https" or not parsed.netloc:
        fail("recovery approval URL must use HTTPS")
    if ca_file is None or not ca_file.is_file():
        fail("RECOVERY_APPROVAL_CA_FILE must name an approved CA bundle for HTTPS approval lookup")
    context = ssl.create_default_context(cafile=str(ca_file))
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "deliveryplatform-recovery-verifier/1"})
    try:
        with urllib.request.urlopen(request, context=context, timeout=10) as response:
            if response.status != 200:
                fail(f"approval lookup returned HTTP {response.status}")
            return response.read(MAX_APPROVAL_BYTES + 1)
    except Exception as exc:  # urllib surfaces transport/TLS errors as heterogeneous exception types.
        fail(f"approval lookup failed: {exc}")


def expect_string(payload: dict[str, Any], key: str, expected: str) -> None:
    actual = payload.get(key)
    if actual != expected:
        fail(f"payload {key} does not match the requested close action")


def verify_ed25519(payload_bytes: bytes, signature: bytes, public_key: Path) -> None:
    if not public_key.is_file():
        fail("RECOVERY_APPROVAL_PUBLIC_KEY_FILE must name a readable Ed25519 public key")
    with tempfile.TemporaryDirectory(prefix="recovery-approval-") as temporary_directory:
        payload_path = Path(temporary_directory) / "payload.json"
        signature_path = Path(temporary_directory) / "signature.bin"
        payload_path.write_bytes(payload_bytes)
        signature_path.write_bytes(signature)
        result = subprocess.run(
            ["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(public_key), "-rawin", "-in", str(payload_path), "-sigfile", str(signature_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
    if result.returncode != 0:
        fail("Ed25519 signature verification failed")


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify a signed circuit-breaker recovery approval")
    parser.add_argument("--url", required=True)
    parser.add_argument("--public-key", required=True, type=Path)
    parser.add_argument("--expected-key-id", required=True)
    parser.add_argument("--ca-file", type=Path)
    parser.add_argument("--incident-id", required=True)
    parser.add_argument("--recovery-evidence-id", required=True)
    parser.add_argument("--environment", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--breaker-name", required=True)
    parser.add_argument("--required-action", choices=("half_open", "close"), required=True)
    parser.add_argument("--allow-local-file", action="store_true")
    arguments = parser.parse_args()

    for name, value in (
        ("incident-id", arguments.incident_id),
        ("recovery-evidence-id", arguments.recovery_evidence_id),
        ("environment", arguments.environment),
        ("namespace", arguments.namespace),
        ("breaker-name", arguments.breaker_name),
        ("expected-key-id", arguments.expected_key_id),
    ):
        require_identifier(name, value)

    raw_envelope = read_approval(arguments.url, arguments.ca_file, arguments.allow_local_file)
    if len(raw_envelope) > MAX_APPROVAL_BYTES:
        fail("approval artifact exceeds the 64 KiB limit")
    try:
        envelope = json.loads(raw_envelope)
    except json.JSONDecodeError:
        fail("approval artifact is not JSON")
    if not isinstance(envelope, dict):
        fail("approval envelope must be a JSON object")
    if envelope.get("signature_algorithm") != "ed25519":
        fail("approval signature_algorithm must be ed25519")
    payload_b64 = envelope.get("payload_b64")
    signature_b64 = envelope.get("signature_b64")
    key_id = envelope.get("key_id")
    if not isinstance(payload_b64, str) or not isinstance(signature_b64, str) or not isinstance(key_id, str):
        fail("approval envelope requires payload_b64, signature_b64, and key_id")
    require_identifier("key_id", key_id)
    if key_id != arguments.expected_key_id:
        fail("approval envelope key_id does not match the configured trusted key")
    try:
        payload_bytes = base64.b64decode(payload_b64, validate=True)
        signature = base64.b64decode(signature_b64, validate=True)
    except ValueError:
        fail("approval envelope contains invalid base64")
    if not payload_bytes or len(signature) != 64:
        fail("approval payload or Ed25519 signature is invalid")
    try:
        payload = json.loads(payload_bytes)
    except json.JSONDecodeError:
        fail("approval payload is not JSON")
    if not isinstance(payload, dict):
        fail("approval payload must be a JSON object")
    canonical_payload = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if canonical_payload != payload_bytes:
        fail("approval payload is not canonical JSON")

    approval_id = payload.get("approval_id")
    if not isinstance(approval_id, str):
        fail("approval payload approval_id is required")
    require_identifier("approval_id", approval_id)
    expect_string(payload, "purpose", "resilience-circuit-breaker-recovery")
    expect_string(payload, "action", arguments.required_action)
    expect_string(payload, "incident_id", arguments.incident_id)
    expect_string(payload, "recovery_evidence_id", arguments.recovery_evidence_id)
    expect_string(payload, "environment", arguments.environment)
    expect_string(payload, "namespace", arguments.namespace)
    expect_string(payload, "breaker_name", arguments.breaker_name)

    issued_at = parse_time("issued_at", payload.get("issued_at"))
    expires_at = parse_time("expires_at", payload.get("expires_at"))
    now = dt.datetime.now(dt.timezone.utc)
    if issued_at > now + FUTURE_SKEW:
        fail("approval issued_at is too far in the future")
    if expires_at <= now:
        fail("approval has expired")
    if expires_at <= issued_at or expires_at - issued_at > MAX_APPROVAL_TTL:
        fail("approval validity window is invalid or exceeds 24 hours")

    verify_ed25519(payload_bytes, signature, arguments.public_key)
    digest = hashlib.sha256(payload_bytes).hexdigest()
    verified_at = now.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    print(f"{approval_id}\t{key_id}\t{digest}\t{verified_at}")


if __name__ == "__main__":
    main()
