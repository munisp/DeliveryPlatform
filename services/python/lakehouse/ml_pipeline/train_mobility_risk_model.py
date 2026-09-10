"""Governed Ray Data + PyTorch training from an immutable lakehouse feature snapshot.

This is an OFFLINE / bounded micro-batch training entrypoint. It intentionally
refuses to read raw operational PostgreSQL, payment, tracker, vehicle-control,
or document-forensics data. A separate governed exporter must first write an
approved Iceberg or Delta snapshot as Parquet, attest its split row counts, and
sign the manifest with an approved Ed25519 key. Outputs are evaluation
checkpoints, not operational control decisions.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import ray
import torch
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from ray import train
from ray.air.config import RunConfig
from ray.train import Checkpoint, CheckpointConfig, ScalingConfig
from ray.train.torch import TorchTrainer, prepare_model
from torch import nn

FEATURE_COLUMNS = (
    "geofence_breach_count_24h",
    "stationary_ratio_1h",
    "speed_p95_kph_24h",
    "tracker_signal_gap_p95_seconds",
    "inventory_reservation_lag_p95_seconds",
    "settlement_exception_count_30d",
)
LABEL_COLUMN = "eligible_label"
REQUIRED_COLUMNS = (
    "feature_row_id",
    "feature_set_version",
    "source_snapshot_ref",
    "source_event_watermark",
    "consent_status",
    "feature_policy_version",
    "label_available_at",
    "event_date",
    *FEATURE_COLUMNS,
    LABEL_COLUMN,
)
APPROVED_FEATURE_TABLE = "lakehouse.silver.mobility_training_features_v1"
MANIFEST_VERSION = "1"


@dataclass(frozen=True)
class SnapshotManifest:
    feature_table: str
    snapshot_ref: str
    feature_set_version: str
    feature_policy_version: str
    redaction_profile: str
    generated_at: str
    training_cutoff_date: str
    split_row_counts: dict[str, int]
    parquet_uris: tuple[str, ...]
    signing_key_id: str
    sha256: str


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required")
    return value


def _canonical_manifest_payload(document: dict[str, Any]) -> bytes:
    """Serialize exactly the fields authenticated by the producer signature."""
    payload = {
        key: value
        for key, value in document.items()
        if key not in {"sha256", "signature_ed25519_base64"}
    }
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _trusted_signing_key(key_id: str) -> Ed25519PublicKey:
    try:
        raw_keys = json.loads(_require("LAKEHOUSE_TRAINING_SIGNER_KEYS_JSON"))
    except json.JSONDecodeError as error:
        raise ValueError("LAKEHOUSE_TRAINING_SIGNER_KEYS_JSON must be a JSON object") from error
    if not isinstance(raw_keys, dict) or not isinstance(raw_keys.get(key_id), str):
        raise ValueError("training manifest signing key is not approved")
    try:
        encoded = base64.b64decode(raw_keys[key_id], validate=True)
    except ValueError as error:
        raise ValueError("approved signing key must be base64-encoded") from error
    if len(encoded) != 32:
        raise ValueError("approved Ed25519 public key must be exactly 32 bytes")
    return Ed25519PublicKey.from_public_bytes(encoded)


def _load_manifest(path: Path) -> SnapshotManifest:
    raw = path.read_bytes()
    try:
        document = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError("training manifest must be valid JSON") from error
    if not isinstance(document, dict):
        raise ValueError("training manifest must be a JSON object")

    declared_digest = document.get("sha256", "")
    signature = document.get("signature_ed25519_base64", "")
    key_id = document.get("signing_key_id", "")
    canonical = _canonical_manifest_payload(document)
    actual_digest = hashlib.sha256(canonical).hexdigest()
    if not isinstance(declared_digest, str) or not hmac.compare_digest(declared_digest, actual_digest):
        raise ValueError("training manifest digest mismatch")
    if not isinstance(signature, str) or not isinstance(key_id, str) or not key_id:
        raise ValueError("training manifest must include an approved Ed25519 signature")
    try:
        signature_bytes = base64.b64decode(signature, validate=True)
        _trusted_signing_key(key_id).verify(signature_bytes, canonical)
    except (ValueError, InvalidSignature) as error:
        raise ValueError("training manifest signature verification failed") from error

    uris = document.get("parquet_uris")
    if (
        not isinstance(uris, list)
        or not uris
        or len(uris) > 10_000
        or any(
            not isinstance(uri, str)
            or not uri.startswith(("s3://", "gs://", "abfs://", "file://"))
            or not uri.lower().split("?", 1)[0].endswith(".parquet")
            for uri in uris
        )
    ):
        raise ValueError("training manifest must contain 1..10000 approved Parquet URIs")

    fields = (
        "manifest_version",
        "feature_table",
        "snapshot_ref",
        "feature_set_version",
        "feature_policy_version",
        "redaction_profile",
        "generated_at",
        "training_cutoff_date",
    )
    if any(not isinstance(document.get(field), str) or not document[field] for field in fields):
        raise ValueError("training manifest is missing required identity fields")
    if document["manifest_version"] != MANIFEST_VERSION:
        raise ValueError("unsupported training manifest version")

    split_row_counts = document.get("split_row_counts")
    if (
        not isinstance(split_row_counts, dict)
        or set(split_row_counts) != {"train", "validation"}
        or any(
            not isinstance(split_row_counts.get(name), int)
            or isinstance(split_row_counts.get(name), bool)
            or split_row_counts[name] <= 0
            for name in ("train", "validation")
        )
    ):
        raise ValueError("manifest must attest positive train and validation row counts")

    return SnapshotManifest(
        feature_table=document["feature_table"],
        snapshot_ref=document["snapshot_ref"],
        feature_set_version=document["feature_set_version"],
        feature_policy_version=document["feature_policy_version"],
        redaction_profile=document["redaction_profile"],
        generated_at=document["generated_at"],
        training_cutoff_date=document["training_cutoff_date"],
        split_row_counts={"train": split_row_counts["train"], "validation": split_row_counts["validation"]},
        parquet_uris=tuple(uris),
        signing_key_id=key_id,
        sha256=declared_digest,
    )


def _validate_manifest(manifest: SnapshotManifest, args: argparse.Namespace) -> None:
    if manifest.feature_table != APPROVED_FEATURE_TABLE:
        raise ValueError("only the approved mobility feature table is permitted")
    if manifest.snapshot_ref != args.snapshot_ref:
        raise ValueError("manifest snapshot_ref differs from the approved request")
    if manifest.feature_set_version != args.feature_set_version:
        raise ValueError("manifest feature-set version differs from the approved request")
    if manifest.feature_policy_version != args.feature_policy_version:
        raise ValueError("manifest feature policy differs from the approved request")
    if manifest.redaction_profile != args.redaction_profile:
        raise ValueError("manifest redaction profile differs from the approved request")
    if manifest.training_cutoff_date != args.training_cutoff_date:
        raise ValueError("manifest cutoff differs from the approved request")
    if manifest.split_row_counts["train"] < args.batch_size:
        raise ValueError("manifest attests fewer training rows than one full batch")


def _prepare_batch(batch: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """Perform only approved numeric normalization; reject invalid labels/features."""
    features = []
    for column in FEATURE_COLUMNS:
        values = np.asarray(batch[column], dtype=np.float32)
        if not np.all(np.isfinite(values)):
            raise ValueError(f"non-finite value in {column}")
        features.append(values)
    labels = np.asarray(batch[LABEL_COLUMN], dtype=np.int64)
    if not np.all((labels == 0) | (labels == 1)):
        raise ValueError("eligible_label must be binary")
    return {
        "features": np.stack(features, axis=1),
        "label": labels,
    }


def _require_first_row(dataset: Any, split_name: str) -> None:
    """Bounded execution guard; avoids a full Dataset.count() pre-training scan."""
    if not dataset.limit(1).take(1):
        raise ValueError(f"manifest-attested {split_name} split has no readable rows")


def _training_loop(config: dict[str, Any]) -> None:
    train_shard = train.get_dataset_shard("train")
    validation_shard = train.get_dataset_shard("validation")
    model = prepare_model(
        nn.Sequential(
            nn.Linear(len(FEATURE_COLUMNS), 32),
            nn.ReLU(),
            nn.Dropout(0.10),
            nn.Linear(32, 1),
        )
    )
    optimizer = torch.optim.AdamW(model.parameters(), lr=config["learning_rate"])
    loss_fn = nn.BCEWithLogitsLoss()

    for epoch in range(config["epochs"]):
        model.train()
        loss_total = 0.0
        batch_count = 0
        for batch in train_shard.iter_torch_batches(
            batch_size=config["batch_size"],
            dtypes={"features": torch.float32, "label": torch.float32},
            prefetch_batches=config["prefetch_batches"],
            drop_last=True,
        ):
            logits = model(batch["features"]).squeeze(1)
            loss = loss_fn(logits, batch["label"])
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()
            loss_total += float(loss.detach().cpu())
            batch_count += 1

        model.eval()
        correct = 0
        observed = 0
        with torch.no_grad():
            for batch in validation_shard.iter_torch_batches(
                batch_size=config["batch_size"],
                dtypes={"features": torch.float32, "label": torch.float32},
                prefetch_batches=config["prefetch_batches"],
            ):
                predicted = (torch.sigmoid(model(batch["features"]).squeeze(1)) >= 0.5).to(torch.float32)
                correct += int((predicted == batch["label"]).sum().cpu())
                observed += int(batch["label"].numel())

        rank = train.get_context().get_world_rank()
        checkpoint_dir = Path("/tmp") / f"mobility-risk-checkpoint-rank-{rank}-epoch-{epoch}"
        checkpoint_dir.mkdir(parents=True, exist_ok=True)
        torch.save(
            {"epoch": epoch, "model_state_dict": model.module.state_dict() if hasattr(model, "module") else model.state_dict()},
            checkpoint_dir / "model.pt",
        )
        train.report(
            {
                "epoch": epoch,
                "train_loss": loss_total / max(batch_count, 1),
                "validation_accuracy": correct / max(observed, 1),
                "validation_rows": observed,
            },
            checkpoint=Checkpoint.from_directory(str(checkpoint_dir)),
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a governed mobility model from a frozen feature snapshot")
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--snapshot-ref", required=True)
    parser.add_argument("--feature-set-version", required=True)
    parser.add_argument("--feature-policy-version", required=True)
    parser.add_argument("--redaction-profile", required=True)
    parser.add_argument("--training-cutoff-date", required=True)
    parser.add_argument("--epochs", type=int, default=5, choices=range(1, 51))
    parser.add_argument("--workers", type=int, default=2, choices=range(1, 33))
    parser.add_argument("--gpus-per-worker", type=float, default=0.0, choices=(0.0, 1.0))
    parser.add_argument("--batch-size", type=int, default=512, choices=range(32, 8193))
    parser.add_argument("--prefetch-batches", type=int, default=2, choices=range(0, 9))
    args = parser.parse_args()

    _require("LAKEHOUSE_TRAINING_OUTPUT_URI")
    manifest = _load_manifest(args.manifest)
    _validate_manifest(manifest, args)

    # A frozen, signed manifest prevents later operational events or rows from a
    # changed feature/consent policy from silently entering this training run.
    ray.init(address=os.environ.get("RAY_ADDRESS") or None, ignore_reinit_error=True)
    dataset = ray.data.read_parquet(list(manifest.parquet_uris), columns=list(REQUIRED_COLUMNS))
    dataset = dataset.filter(
        lambda row: row["consent_status"] == "granted"
        and row["feature_set_version"] == args.feature_set_version
        and row["feature_policy_version"] == args.feature_policy_version
        and row["source_snapshot_ref"] == args.snapshot_ref
        and row["label_available_at"] is not None
    ).map_batches(_prepare_batch, batch_format="numpy")

    train_data = dataset.filter(lambda row: str(row["event_date"]) < args.training_cutoff_date)
    validation_data = dataset.filter(lambda row: str(row["event_date"]) >= args.training_cutoff_date)
    _require_first_row(train_data, "train")
    _require_first_row(validation_data, "validation")

    trainer = TorchTrainer(
        _training_loop,
        train_loop_config={
            "epochs": args.epochs,
            "batch_size": args.batch_size,
            "prefetch_batches": args.prefetch_batches,
            "learning_rate": 0.001,
        },
        scaling_config=ScalingConfig(num_workers=args.workers, use_gpu=args.gpus_per_worker > 0),
        run_config=RunConfig(
            name=f"mobility-risk-{manifest.snapshot_ref}",
            storage_path=_require("LAKEHOUSE_TRAINING_OUTPUT_URI"),
            checkpoint_config=CheckpointConfig(num_to_keep=2, checkpoint_score_attribute="validation_accuracy", checkpoint_score_order="max"),
        ),
        datasets={"train": train_data, "validation": validation_data},
    )
    result = trainer.fit()
    print(json.dumps({"result": "completed", "metrics": result.metrics, "manifest_sha256": manifest.sha256, "manifest_signing_key_id": manifest.signing_key_id}, sort_keys=True))


if __name__ == "__main__":
    main()
