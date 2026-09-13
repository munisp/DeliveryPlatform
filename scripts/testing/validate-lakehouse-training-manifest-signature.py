#!/usr/bin/env python3
"""Validate the signed Ray manifest producer and monitoring consumer locally."""
from __future__ import annotations

import base64
import importlib.util
import json
import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ROOT = Path(__file__).resolve().parents[2]
PIPELINE = ROOT / "services/python/lakehouse/ml_pipeline"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if not spec or not spec.loader:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    signer = load_module("manifest_signer", PIPELINE / "sign_training_snapshot_manifest.py")
    exporter = load_module("manifest_exporter", PIPELINE / "manifest_status_exporter.py")
    private = Ed25519PrivateKey.generate()
    raw_private = private.private_bytes_raw()
    raw_public = private.public_key().public_bytes_raw()
    original = dict(os.environ)
    with tempfile.TemporaryDirectory(prefix="lakehouse-signature-") as directory:
        root = Path(directory)
        unsigned = root / "unsigned.json"
        signed = root / "approved-manifest.json"
        unsigned.write_text(json.dumps({
            "manifest_version": "1",
            "feature_table": "lakehouse.silver.mobility_training_features_v1",
            "snapshot_ref": "iceberg://catalog/snapshot-123",
            "feature_set_version": "v1",
            "feature_policy_version": "v1",
            "redaction_profile": "governed-v1",
            "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "training_cutoff_date": "2026-09-01",
            "split_row_counts": {"train": 512, "validation": 64},
            "parquet_uris": ["file:///tmp/governed-training.parquet"],
        }), encoding="utf-8")
        os.environ["LAKEHOUSE_TRAINING_SIGNER_PRIVATE_KEY_BASE64"] = base64.b64encode(raw_private).decode("ascii")
        import sys
        argv = sys.argv
        try:
            sys.argv = ["sign", "--input", str(unsigned), "--output", str(signed), "--signing-key-id", "test-ed25519-v1"]
            signer.main()
        finally:
            sys.argv = argv
        os.environ["LAKEHOUSE_TRAINING_MANIFEST_PATH"] = str(signed)
        os.environ["LAKEHOUSE_TRAINING_SIGNER_KEYS_JSON"] = json.dumps({"test-ed25519-v1": base64.b64encode(raw_public).decode("ascii")})
        valid, age = exporter._load_status()
        assert valid == 1 and age >= 0, (valid, age)
        document = json.loads(signed.read_text(encoding="utf-8"))
        document["split_row_counts"]["train"] = 513
        signed.write_text(json.dumps(document), encoding="utf-8")
        valid, age = exporter._load_status()
        assert (valid, age) == (0, 0), (valid, age)
    os.environ.clear()
    os.environ.update(original)
    print("lakehouse_training_manifest_signature_result=PASS verified=1 tampered_rejected=1")


if __name__ == "__main__":
    main()
