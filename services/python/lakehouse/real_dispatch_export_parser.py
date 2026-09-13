#!/usr/bin/env python3
"""Fail-closed parser for provenance-attested historical dispatch-decision exports.

A producer computes ``source_export_digest`` over canonical JSONL records with
that provenance field omitted. Each delivered record then carries the resulting
digest, and the detached manifest carries the same value. This avoids a
self-referential checksum while making the logged decision payload tamper-evident.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import pathlib
from dataclasses import dataclass
from typing import Any

try:
    from .offline_rl_policy_evaluator import DecisionRecord, PolicyEvaluationError, parse_record
except ImportError:  # Direct script execution from this directory.
    from offline_rl_policy_evaluator import DecisionRecord, PolicyEvaluationError, parse_record

MANIFEST_SCHEMA_VERSION = 1
RECORD_SCHEMA_VERSION = 1
REQUIRED_MANIFEST_FIELDS = frozenset(
    {
        "manifest_schema_version",
        "record_schema_version",
        "source_export_digest",
        "domain",
        "source_system",
        "exported_at",
        "reward_definition_version",
        "propensity_logger_version",
        "append_only_attested",
        "propensities_recorded_at_decision_time",
        "direct_identifiers_removed",
        "location_traces_removed",
    }
)
REQUIRED_PROVENANCE_RECORD_FIELDS = frozenset({"event_time", "source_export_digest", "schema_version"})
FORBIDDEN_FIELD_TOKENS = frozenset(
    {
        "driver_id",
        "customer_id",
        "rider_id",
        "merchant_id",
        "phone",
        "email",
        "address",
        "latitude",
        "longitude",
        "location",
        "geometry",
        "device_id",
        "license",
    }
)


@dataclass(frozen=True)
class RealDispatchExport:
    manifest_digest: str
    manifest: dict[str, Any]
    records: tuple[DecisionRecord, ...]


def _canonical_digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    ).hexdigest()


def _require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PolicyEvaluationError(f"{label} must be a JSON object")
    return value


def _require_non_empty_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PolicyEvaluationError(f"{field} must be a non-empty string")
    return value.strip()


def _parse_utc(value: Any, field: str) -> dt.datetime:
    text = _require_non_empty_string(value, field)
    normalized = f"{text[:-1]}+00:00" if text.endswith("Z") else text
    try:
        parsed = dt.datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise PolicyEvaluationError(f"{field} must be ISO-8601 UTC") from exc
    if parsed.tzinfo is None or parsed.utcoffset() != dt.timedelta(0):
        raise PolicyEvaluationError(f"{field} must include a UTC offset")
    return parsed


def _reject_forbidden_fields(value: Any, path: str = "record") -> None:
    if isinstance(value, dict):
        for key, nested in value.items():
            key_text = _require_non_empty_string(key, f"{path} key").lower()
            if key_text in FORBIDDEN_FIELD_TOKENS:
                raise PolicyEvaluationError(f"{path}.{key_text} is forbidden in a redacted dispatch export")
            _reject_forbidden_fields(nested, f"{path}.{key_text}")
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            _reject_forbidden_fields(nested, f"{path}[{index}]")


def _read_canonical_records(path: pathlib.Path) -> tuple[list[dict[str, Any]], str]:
    digest = hashlib.sha256()
    records: list[dict[str, Any]] = []
    try:
        source = path.open("r", encoding="utf-8")
    except OSError as exc:
        raise PolicyEvaluationError(f"cannot read records: {exc}") from exc
    with source:
        for line_number, raw_line in enumerate(source, start=1):
            if not raw_line.strip():
                raise PolicyEvaluationError(f"line {line_number}: blank records are forbidden in historical exports")
            try:
                raw = _require_object(json.loads(raw_line), f"line {line_number}")
            except json.JSONDecodeError as exc:
                raise PolicyEvaluationError(f"line {line_number}: invalid JSON") from exc
            canonical = dict(raw)
            canonical.pop("source_export_digest", None)
            digest.update(json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8"))
            digest.update(b"\n")
            records.append(raw)
    return records, digest.hexdigest()


def load_real_dispatch_export(records_path: pathlib.Path, manifest_path: pathlib.Path) -> RealDispatchExport:
    """Load a manifest-attested, redacted dispatch export or fail closed."""
    try:
        manifest = _require_object(json.loads(manifest_path.read_text(encoding="utf-8")), "manifest")
    except OSError as exc:
        raise PolicyEvaluationError(f"cannot read manifest: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise PolicyEvaluationError("manifest is invalid JSON") from exc

    missing = sorted(REQUIRED_MANIFEST_FIELDS.difference(manifest))
    if missing:
        raise PolicyEvaluationError(f"manifest missing required fields: {', '.join(missing)}")
    if manifest["manifest_schema_version"] != MANIFEST_SCHEMA_VERSION:
        raise PolicyEvaluationError("unsupported manifest_schema_version")
    if manifest["record_schema_version"] != RECORD_SCHEMA_VERSION:
        raise PolicyEvaluationError("unsupported record_schema_version")
    for attestation in (
        "append_only_attested",
        "propensities_recorded_at_decision_time",
        "direct_identifiers_removed",
        "location_traces_removed",
    ):
        if manifest[attestation] is not True:
            raise PolicyEvaluationError(f"manifest attestation {attestation} must be true")
    _parse_utc(manifest["exported_at"], "manifest.exported_at")
    declared_domain = _require_non_empty_string(manifest["domain"], "manifest.domain").lower()
    declared_digest = _require_non_empty_string(manifest["source_export_digest"], "manifest.source_export_digest").lower()
    if len(declared_digest) != 64 or any(character not in "0123456789abcdef" for character in declared_digest):
        raise PolicyEvaluationError("manifest.source_export_digest must be a SHA-256 hex digest")

    raw_records, actual_digest = _read_canonical_records(records_path)
    if actual_digest != declared_digest:
        raise PolicyEvaluationError("source export digest does not match the canonical records file")

    records: list[DecisionRecord] = []
    seen_ids: set[str] = set()
    for line_number, raw in enumerate(raw_records, start=1):
        missing_record_fields = sorted(REQUIRED_PROVENANCE_RECORD_FIELDS.difference(raw))
        if missing_record_fields:
            raise PolicyEvaluationError(f"line {line_number}: missing provenance fields: {', '.join(missing_record_fields)}")
        _reject_forbidden_fields(raw, f"line {line_number}")
        if raw["schema_version"] != RECORD_SCHEMA_VERSION:
            raise PolicyEvaluationError(f"line {line_number}: unsupported record schema_version")
        if _require_non_empty_string(raw["source_export_digest"], "source_export_digest").lower() != declared_digest:
            raise PolicyEvaluationError(f"line {line_number}: source_export_digest does not match manifest")
        _parse_utc(raw["event_time"], "event_time")
        record = parse_record(raw)
        if record.domain != declared_domain:
            raise PolicyEvaluationError(f"line {line_number}: domain does not match manifest")
        if record.decision_id in seen_ids:
            raise PolicyEvaluationError(f"line {line_number}: duplicate decision_id {record.decision_id!r}")
        seen_ids.add(record.decision_id)
        records.append(record)
    if not records:
        raise PolicyEvaluationError("historical export contains no records")
    return RealDispatchExport(manifest_digest=_canonical_digest(manifest), manifest=manifest, records=tuple(records))
