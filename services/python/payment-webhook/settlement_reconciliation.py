#!/usr/bin/env python3
"""Stage verified settlement-report metadata and reconcile it without mutating money state.

The report artifact must already be in access-controlled immutable storage. This runner
accepts only its redacted manifest and normalized rows; it has no provider capture,
transfer-submission, payment-state, payout-state, or ledger-writing capability.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

import psycopg
from psycopg.rows import dict_row

LOGGER = logging.getLogger("settlement-reconciliation")
NORMALIZER_VERSION = "settlement-normalizer-v1"
CLASSIFIER_VERSION = "settlement-classifier-v1"
MAX_REPORT_ROWS = 500_000
MAX_REPORT_BYTES = 100 * 1024 * 1024
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE)
CURRENCY = re.compile(r"^[A-Z]{3}$")
ENTRY_KINDS = frozenset({"collection", "payout", "refund", "chargeback", "adjustment"})
REPORT_KINDS = frozenset({"settlement_cycle", "daily_statement"})
PROVIDER_STATES = frozenset({"pending", "settled", "failed", "reversed", "unknown"})
UNEXPLAINED_CLASSES = frozenset(
    {
        "internal_only",
        "provider_only",
        "amount_mismatch",
        "currency_mismatch",
        "fee_mismatch",
        "net_mismatch",
        "duplicate_reference",
        "unverified_financial_state",
        "ledger_imbalance",
        "illegal_state_transition",
        "internal_scope_missing",
        "unsupported_provider_entry",
    }
)


class ReconciliationError(RuntimeError):
    """Base error for controlled settlement report processing."""


class ManifestValidationError(ReconciliationError):
    """Raised when the report manifest is incomplete, malformed, or unsafe."""


class ReconciliationStateError(ReconciliationError):
    """Raised when an import cannot legally advance its reconciliation state."""


@dataclass(frozen=True)
class NormalizedReportRow:
    source_line_no: int
    source_record_key: str
    entry_kind: str
    provider_reference: str
    related_provider_reference: str | None
    provider_final_state: str
    provider_final_status: str
    currency: str
    gross_minor: int
    fee_minor: int
    net_minor: int
    occurred_at: datetime | None
    settled_at: datetime | None
    source_row_sha256: bytes
    normalized_metadata: dict[str, Any]


@dataclass(frozen=True)
class ReportManifest:
    merchant_account_id: str
    provider_report_id: str
    report_kind: str
    period_start: datetime
    period_end: datetime
    retrieved_at: datetime
    source_object_ref: str
    source_content_type: str
    source_bytes: int
    source_sha256: bytes
    retrieval_actor: str
    rows: tuple[NormalizedReportRow, ...]


@dataclass(frozen=True)
class ClassifiedRow:
    provider_row_id: str | None
    provider_payment_id: str | None
    payout_instruction_id: str | None
    entry_kind: str
    provider_reference: str
    classification: str
    severity: str
    reported_currency: str | None
    expected_currency: str | None
    reported_gross_minor: int | None
    expected_gross_minor: int | None
    reported_fee_minor: int | None
    expected_fee_minor: int | None
    reported_net_minor: int | None
    expected_net_minor: int | None
    facts: dict[str, Any]


def configure_logging() -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(message)s"))
    LOGGER.handlers.clear()
    LOGGER.addHandler(handler)
    LOGGER.setLevel(logging.INFO)
    LOGGER.propagate = False


def log_event(event: str, **fields: Any) -> None:
    payload: dict[str, Any] = {"service": "settlement-reconciliation", "event": event}
    for key, value in fields.items():
        if value is not None:
            payload[key] = value
    LOGGER.info(json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str))


def require_database_url(value: str | None) -> str:
    database_url = (value or "").strip()
    if not database_url.startswith(("postgresql://", "postgres://")):
        raise ReconciliationError("SETTLEMENT_RECONCILIATION_DATABASE_URL must be a PostgreSQL connection URL")
    return database_url


def parse_uuid(value: Any, field: str) -> str:
    candidate = str(value or "").strip()
    if not UUID.fullmatch(candidate):
        raise ManifestValidationError(f"{field} must be a canonical UUID")
    return candidate.lower()


def parse_text(value: Any, field: str, minimum: int, maximum: int) -> str:
    candidate = str(value or "").strip()
    if len(candidate) < minimum or len(candidate) > maximum or "\x00" in candidate:
        raise ManifestValidationError(f"{field} must contain between {minimum} and {maximum} characters")
    return candidate


def parse_timestamp(value: Any, field: str, required: bool = True) -> datetime | None:
    if value is None or value == "":
        if required:
            raise ManifestValidationError(f"{field} is required")
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError as error:
        raise ManifestValidationError(f"{field} must use RFC3339/ISO-8601 time") from error
    if parsed.tzinfo is None:
        raise ManifestValidationError(f"{field} must include a timezone")
    return parsed.astimezone(timezone.utc)


def parse_minor(value: Any, field: str) -> int:
    if isinstance(value, bool):
        raise ManifestValidationError(f"{field} must be an integer minor-unit amount")
    if isinstance(value, int):
        return value
    if isinstance(value, str) and re.fullmatch(r"-?[0-9]+", value.strip()):
        return int(value.strip())
    raise ManifestValidationError(f"{field} must be an integer minor-unit amount")


def parse_sha256(value: Any, field: str) -> bytes:
    candidate = str(value or "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", candidate):
        raise ManifestValidationError(f"{field} must be a 64-character lowercase hexadecimal SHA-256 digest")
    return bytes.fromhex(candidate)


def require_mapping(value: Any, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ManifestValidationError(f"{field} must be a JSON object")
    return value


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("utf-8")


def normalize_row(value: Any, ordinal: int) -> NormalizedReportRow:
    raw = require_mapping(value, f"rows[{ordinal}]")
    line_no = raw.get("source_line_no", ordinal)
    if isinstance(line_no, bool) or not isinstance(line_no, int) or line_no <= 0:
        raise ManifestValidationError(f"rows[{ordinal}].source_line_no must be a positive integer")
    source_record_key = parse_text(raw.get("source_record_key"), f"rows[{ordinal}].source_record_key", 1, 200)
    entry_kind = str(raw.get("entry_kind", "")).strip().lower()
    if entry_kind not in ENTRY_KINDS:
        raise ManifestValidationError(f"rows[{ordinal}].entry_kind is not supported")
    provider_reference = parse_text(raw.get("provider_reference"), f"rows[{ordinal}].provider_reference", 4, 200)
    related = raw.get("related_provider_reference")
    related_reference = parse_text(related, f"rows[{ordinal}].related_provider_reference", 4, 200) if related is not None else None
    provider_final_state = str(raw.get("provider_final_state", "")).strip().lower()
    if provider_final_state not in PROVIDER_STATES:
        raise ManifestValidationError(f"rows[{ordinal}].provider_final_state is not supported")
    provider_final_status = parse_text(raw.get("provider_final_status"), f"rows[{ordinal}].provider_final_status", 1, 160)
    currency = str(raw.get("currency", "")).strip().upper()
    if not CURRENCY.fullmatch(currency):
        raise ManifestValidationError(f"rows[{ordinal}].currency must be a three-letter uppercase code")
    gross_minor = parse_minor(raw.get("gross_minor"), f"rows[{ordinal}].gross_minor")
    fee_minor = parse_minor(raw.get("fee_minor"), f"rows[{ordinal}].fee_minor")
    net_minor = parse_minor(raw.get("net_minor"), f"rows[{ordinal}].net_minor")
    if net_minor != gross_minor - fee_minor:
        raise ManifestValidationError(f"rows[{ordinal}] must satisfy net_minor = gross_minor - fee_minor")
    if gross_minor == 0 and fee_minor == 0 and net_minor == 0:
        raise ManifestValidationError(f"rows[{ordinal}] must contain a non-zero monetary value")
    metadata = raw.get("normalized_metadata", {})
    if not isinstance(metadata, dict):
        raise ManifestValidationError(f"rows[{ordinal}].normalized_metadata must be a JSON object")
    if len(canonical_json(metadata)) > 16_384:
        raise ManifestValidationError(f"rows[{ordinal}].normalized_metadata exceeds 16 KiB")
    occurred_at = parse_timestamp(raw.get("occurred_at"), f"rows[{ordinal}].occurred_at", required=False)
    settled_at = parse_timestamp(raw.get("settled_at"), f"rows[{ordinal}].settled_at", required=False)
    if occurred_at is not None and settled_at is not None and settled_at < occurred_at:
        raise ManifestValidationError(f"rows[{ordinal}].settled_at cannot be earlier than occurred_at")
    hashed_fields = {
        "source_line_no": line_no,
        "source_record_key": source_record_key,
        "entry_kind": entry_kind,
        "provider_reference": provider_reference,
        "related_provider_reference": related_reference,
        "provider_final_state": provider_final_state,
        "provider_final_status": provider_final_status,
        "currency": currency,
        "gross_minor": gross_minor,
        "fee_minor": fee_minor,
        "net_minor": net_minor,
        "occurred_at": occurred_at.isoformat() if occurred_at else None,
        "settled_at": settled_at.isoformat() if settled_at else None,
        "normalized_metadata": metadata,
    }
    supplied_digest = raw.get("source_row_sha256")
    calculated_digest = hashlib.sha256(canonical_json(hashed_fields)).digest()
    if supplied_digest is not None and parse_sha256(supplied_digest, f"rows[{ordinal}].source_row_sha256") != calculated_digest:
        raise ManifestValidationError(f"rows[{ordinal}].source_row_sha256 does not match normalized values")
    return NormalizedReportRow(
        source_line_no=line_no,
        source_record_key=source_record_key,
        entry_kind=entry_kind,
        provider_reference=provider_reference,
        related_provider_reference=related_reference,
        provider_final_state=provider_final_state,
        provider_final_status=provider_final_status,
        currency=currency,
        gross_minor=gross_minor,
        fee_minor=fee_minor,
        net_minor=net_minor,
        occurred_at=occurred_at,
        settled_at=settled_at,
        source_row_sha256=calculated_digest,
        normalized_metadata=metadata,
    )


def load_manifest(path: Path) -> ReportManifest:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise ManifestValidationError(f"cannot read report manifest: {error}") from error
    except json.JSONDecodeError as error:
        raise ManifestValidationError(f"report manifest is not valid JSON: {error.msg}") from error
    payload = require_mapping(raw, "report manifest")
    merchant_account_id = parse_uuid(payload.get("merchant_account_id"), "merchant_account_id")
    provider_report_id = parse_text(payload.get("provider_report_id"), "provider_report_id", 8, 200)
    report_kind = str(payload.get("report_kind", "")).strip()
    if report_kind not in REPORT_KINDS:
        raise ManifestValidationError("report_kind must be settlement_cycle or daily_statement")
    period_start = parse_timestamp(payload.get("period_start"), "period_start")
    period_end = parse_timestamp(payload.get("period_end"), "period_end")
    if period_end <= period_start:
        raise ManifestValidationError("period_end must be later than period_start")
    retrieved_at = parse_timestamp(payload.get("retrieved_at"), "retrieved_at")
    source_object_ref = parse_text(payload.get("source_object_ref"), "source_object_ref", 16, 512)
    source_content_type = str(payload.get("source_content_type", "")).strip().lower()
    if source_content_type not in {"text/csv", "application/json"}:
        raise ManifestValidationError("source_content_type must be text/csv or application/json")
    source_bytes = parse_minor(payload.get("source_bytes"), "source_bytes")
    if source_bytes <= 0 or source_bytes > MAX_REPORT_BYTES:
        raise ManifestValidationError("source_bytes must be between 1 and 104857600")
    source_sha256 = parse_sha256(payload.get("source_sha256"), "source_sha256")
    retrieval_actor = parse_text(payload.get("retrieval_actor"), "retrieval_actor", 3, 128)
    raw_rows = payload.get("rows")
    if not isinstance(raw_rows, list) or not raw_rows:
        raise ManifestValidationError("rows must be a non-empty JSON array")
    if len(raw_rows) > MAX_REPORT_ROWS:
        raise ManifestValidationError(f"rows exceeds maximum of {MAX_REPORT_ROWS}")
    rows = tuple(normalize_row(item, position) for position, item in enumerate(raw_rows, start=1))
    line_numbers = [row.source_line_no for row in rows]
    record_keys = [row.source_record_key for row in rows]
    if len(line_numbers) != len(set(line_numbers)):
        raise ManifestValidationError("source_line_no must be unique within a report")
    if len(record_keys) != len(set(record_keys)):
        raise ManifestValidationError("source_record_key must be unique within a report")
    return ReportManifest(
        merchant_account_id=merchant_account_id,
        provider_report_id=provider_report_id,
        report_kind=report_kind,
        period_start=period_start,
        period_end=period_end,
        retrieved_at=retrieved_at,
        source_object_ref=source_object_ref,
        source_content_type=source_content_type,
        source_bytes=source_bytes,
        source_sha256=source_sha256,
        retrieval_actor=retrieval_actor,
        rows=rows,
    )


def verify_artifact(path: Path, manifest: ReportManifest) -> None:
    """Stream the restricted artifact once and verify its immutable source metadata."""
    try:
        with path.open("rb") as artifact:
            digest = hashlib.sha256()
            total = 0
            first_non_whitespace = b""
            while True:
                chunk = artifact.read(64 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_REPORT_BYTES:
                    raise ManifestValidationError("report artifact exceeds maximum size")
                digest.update(chunk)
                if len(first_non_whitespace) < 16:
                    first_non_whitespace += bytes(
                        byte for byte in chunk if byte not in {9, 10, 13, 32}
                    )[: 16 - len(first_non_whitespace)]
    except OSError as error:
        raise ManifestValidationError(f"cannot read report artifact: {error}") from error
    if total != manifest.source_bytes:
        raise ManifestValidationError("report artifact byte count does not match manifest")
    if digest.digest() != manifest.source_sha256:
        raise ManifestValidationError("report artifact SHA-256 does not match manifest")
    if manifest.source_content_type == "application/json" and not first_non_whitespace.startswith((b"{", b"[")):
        raise ManifestValidationError("JSON report artifact does not begin with an object or array")
    if manifest.source_content_type == "text/csv" and not first_non_whitespace:
        raise ManifestValidationError("CSV report artifact is empty")


def validate_resilience_run_id(value: str | None) -> str | None:
    candidate = (value or "").strip()
    if not candidate:
        return None
    if not IDENTIFIER.fullmatch(candidate):
        raise ReconciliationError("resilience run ID must use 3-81 letters, digits, dots, underscores, or hyphens")
    return candidate


def optional_user_id(value: int | None) -> int | None:
    if value is None:
        return None
    if value <= 0:
        raise ReconciliationError("requested-by must be a positive public.users ID")
    return value


def import_key(manifest: ReportManifest, normalizer_version: str) -> str:
    material = b"|".join(
        (
            manifest.merchant_account_id.encode("ascii"),
            manifest.provider_report_id.encode("utf-8"),
            manifest.source_sha256.hex().encode("ascii"),
            normalizer_version.encode("ascii"),
        )
    )
    return "settlement-import-" + hashlib.sha256(material).hexdigest()


def verify_active_merchant(connection: psycopg.Connection[dict[str, Any]], merchant_account_id: str) -> dict[str, Any]:
    merchant = connection.execute(
        """
        SELECT id::text, provider, settlement_currency
        FROM mobility.settlement_merchant_account
        WHERE id = %s::uuid AND active = true AND retired_at IS NULL
        """,
        (merchant_account_id,),
    ).fetchone()
    if merchant is None:
        raise ReconciliationStateError("merchant account is missing, inactive, or retired")
    return merchant


def locate_or_create_source(connection: psycopg.Connection[dict[str, Any]], manifest: ReportManifest) -> str:
    connection.execute(
        """
        INSERT INTO mobility.settlement_report_source (
          merchant_account_id, provider_report_id, report_kind, period_start, period_end,
          retrieved_at, source_object_ref, source_content_type, source_bytes, source_sha256,
          retrieval_actor
        ) VALUES (%s::uuid,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON CONFLICT DO NOTHING
        """,
        (
            manifest.merchant_account_id,
            manifest.provider_report_id,
            manifest.report_kind,
            manifest.period_start,
            manifest.period_end,
            manifest.retrieved_at,
            manifest.source_object_ref,
            manifest.source_content_type,
            manifest.source_bytes,
            manifest.source_sha256,
            manifest.retrieval_actor,
        ),
    )
    sources = connection.execute(
        """
        SELECT id::text, provider_report_id, report_kind, period_start, period_end,
               retrieved_at, source_object_ref, source_content_type, source_bytes,
               encode(source_sha256, 'hex') AS source_sha256, retrieval_actor
        FROM mobility.settlement_report_source
        WHERE merchant_account_id = %s::uuid
          AND (provider_report_id = %s OR source_sha256 = %s)
        """,
        (manifest.merchant_account_id, manifest.provider_report_id, manifest.source_sha256),
    ).fetchall()
    if len(sources) != 1:
        raise ReconciliationStateError("report identity conflicts with an existing source")
    source = sources[0]
    expected = {
        "provider_report_id": manifest.provider_report_id,
        "report_kind": manifest.report_kind,
        "period_start": manifest.period_start,
        "period_end": manifest.period_end,
        "retrieved_at": manifest.retrieved_at,
        "source_object_ref": manifest.source_object_ref,
        "source_content_type": manifest.source_content_type,
        "source_bytes": manifest.source_bytes,
        "source_sha256": manifest.source_sha256.hex(),
        "retrieval_actor": manifest.retrieval_actor,
    }
    if any(source[key] != value for key, value in expected.items()):
        raise ReconciliationStateError("immutable report source metadata differs from existing identity")
    return str(source["id"])


def rows_match_manifest(connection: psycopg.Connection[dict[str, Any]], import_id: str, manifest: ReportManifest) -> bool:
    stored = connection.execute(
        """
        SELECT source_line_no, source_record_key, encode(source_row_sha256, 'hex') AS source_row_sha256
        FROM mobility.settlement_report_row
        WHERE import_id = %s::uuid
        ORDER BY source_line_no
        """,
        (import_id,),
    ).fetchall()
    expected = sorted(manifest.rows, key=lambda item: item.source_line_no)
    return len(stored) == len(expected) and all(
        int(actual["source_line_no"]) == row.source_line_no
        and str(actual["source_record_key"]) == row.source_record_key
        and str(actual["source_row_sha256"]) == row.source_row_sha256.hex()
        for actual, row in zip(stored, expected, strict=True)
    )


def prepare_existing_import(
    connection: psycopg.Connection[dict[str, Any]],
    existing: Mapping[str, Any],
    manifest: ReportManifest,
    normalizer_version: str,
    resilience_run_id: str | None,
    requested_by: int | None,
) -> tuple[str, bool]:
    """Return an idempotent completed import or reset a failed import with no immutable rows."""
    import_id = str(existing["id"])
    state = str(existing["state"])
    if state in {"staged", "reconciling", "reconciled"}:
        if not rows_match_manifest(connection, import_id, manifest):
            raise ReconciliationStateError("existing staged import rows differ from immutable report manifest")
        return import_id, True
    if not rows_match_manifest(connection, import_id, manifest):
        stored_count = connection.execute(
            "SELECT COUNT(*) AS row_count FROM mobility.settlement_report_row WHERE import_id = %s::uuid",
            (import_id,),
        ).fetchone()
        if int(stored_count["row_count"]) != 0:
            raise ReconciliationStateError("failed import contains immutable rows that differ from supplied manifest")
    connection.execute(
        """
        UPDATE mobility.settlement_import
        SET state = 'normalizing', started_at = now(), completed_at = NULL,
            row_count = 0, rejected_row_count = 0, failure_code = NULL,
            resilience_run_id = %s, requested_by = %s, updated_at = now()
        WHERE id = %s::uuid
        """,
        (resilience_run_id, requested_by, import_id),
    )
    return import_id, False


def stage_report(
    connection: psycopg.Connection[dict[str, Any]],
    manifest: ReportManifest,
    normalizer_version: str,
    resilience_run_id: str | None,
    requested_by: int | None,
) -> tuple[str, bool]:
    if not re.fullmatch(r"^[a-z0-9][a-z0-9_.-]{2,80}$", normalizer_version):
        raise ReconciliationError("normalizer version is outside the allowed identifier format")
    with connection.transaction():
        merchant = verify_active_merchant(connection, manifest.merchant_account_id)
        currencies = {row.currency for row in manifest.rows}
        if currencies != {merchant["settlement_currency"]}:
            raise ManifestValidationError("report currencies do not match the merchant settlement currency")
        source_id = locate_or_create_source(connection, manifest)
        key = import_key(manifest, normalizer_version)
        existing = connection.execute(
            """
            SELECT id::text, state::text, row_count
            FROM mobility.settlement_import
            WHERE source_id = %s::uuid AND normalizer_version = %s
            FOR UPDATE
            """,
            (source_id, normalizer_version),
        ).fetchone()
        if existing is not None:
            import_id, completed_or_active = prepare_existing_import(
                connection, existing, manifest, normalizer_version, resilience_run_id, requested_by
            )
            if completed_or_active:
                return import_id, False
        else:
            created = connection.execute(
                """
                INSERT INTO mobility.settlement_import (
                  source_id, normalizer_version, import_key, state, started_at,
                  resilience_run_id, requested_by
                ) VALUES (%s::uuid,%s,%s,'normalizing',now(),%s,%s)
                ON CONFLICT (source_id, normalizer_version) DO NOTHING
                RETURNING id::text
                """,
                (source_id, normalizer_version, key, resilience_run_id, requested_by),
            ).fetchone()
            if created is not None:
                import_id = str(created["id"])
            else:
                existing = connection.execute(
                    """
                    SELECT id::text, state::text, row_count
                    FROM mobility.settlement_import
                    WHERE source_id = %s::uuid AND normalizer_version = %s
                    FOR UPDATE
                    """,
                    (source_id, normalizer_version),
                ).fetchone()
                if existing is None:
                    raise ReconciliationStateError("concurrent settlement import could not be read")
                import_id, completed_or_active = prepare_existing_import(
                    connection, existing, manifest, normalizer_version, resilience_run_id, requested_by
                )
                if completed_or_active:
                    return import_id, False
        existing_rows = connection.execute(
            "SELECT COUNT(*) AS row_count FROM mobility.settlement_report_row WHERE import_id = %s::uuid",
            (import_id,),
        ).fetchone()
        if int(existing_rows["row_count"]) == 0:
            with connection.cursor() as cursor:
                cursor.executemany(
                    """
                    INSERT INTO mobility.settlement_report_row (
                      import_id, source_line_no, source_record_key, entry_kind,
                      provider_reference, related_provider_reference, provider_final_state,
                      provider_final_status, currency, gross_minor, fee_minor, net_minor,
                      occurred_at, settled_at, source_row_sha256, normalized_metadata
                    ) VALUES (
                      %s::uuid,%s,%s,%s::mobility.settlement_entry_kind,%s,%s,
                      %s::mobility.settlement_provider_state,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb
                    )
                    """,
                    [
                        (
                            import_id,
                            row.source_line_no,
                            row.source_record_key,
                            row.entry_kind,
                            row.provider_reference,
                            row.related_provider_reference,
                            row.provider_final_state,
                            row.provider_final_status,
                            row.currency,
                            row.gross_minor,
                            row.fee_minor,
                            row.net_minor,
                            row.occurred_at,
                            row.settled_at,
                            row.source_row_sha256,
                            json.dumps(row.normalized_metadata, sort_keys=True, separators=(",", ":")),
                        )
                        for row in manifest.rows
                    ],
                )
        connection.execute(
            """
            UPDATE mobility.settlement_import
            SET state = 'staged', completed_at = now(), row_count = %s,
                rejected_row_count = 0, failure_code = NULL, updated_at = now()
            WHERE id = %s::uuid
            """,
            (len(manifest.rows), import_id),
        )
        return import_id, True


CLASSIFICATION_QUERY = """
WITH import_context AS (
  SELECT si.id AS import_id, src.merchant_account_id, src.period_start, src.period_end,
         account.provider, account.settlement_grace
  FROM mobility.settlement_import si
  JOIN mobility.settlement_report_source src ON src.id = si.source_id
  JOIN mobility.settlement_merchant_account account ON account.id = src.merchant_account_id
  WHERE si.id = %s::uuid AND si.state IN ('staged', 'reconciling') AND account.active
),
provider_rows AS (
  SELECT context.import_id, context.merchant_account_id, context.period_start,
         context.period_end, context.settlement_grace, context.provider,
         row.id AS provider_row_id, row.entry_kind::text AS entry_kind,
         row.provider_reference, row.currency, row.gross_minor, row.fee_minor,
         row.net_minor, row.provider_final_state::text AS provider_final_state,
         row.provider_final_status, row.occurred_at, row.settled_at,
         COUNT(*) OVER (PARTITION BY context.import_id, row.entry_kind, row.provider_reference)
           AS duplicate_reference_count
  FROM import_context context
  JOIN mobility.settlement_report_row row ON row.import_id = context.import_id
),
collection_ledger AS (
  SELECT pp.id AS provider_payment_id,
         COALESCE(SUM(posting.amount_kobo) FILTER (WHERE posting.direction = 'debit'), 0) AS debit_minor,
         COALESCE(SUM(posting.amount_kobo) FILTER (WHERE posting.direction = 'credit'), 0) AS credit_minor,
         COUNT(posting.id) > 0 AS has_postings
  FROM mobility.provider_payment pp
  JOIN mobility.ledger_transaction transaction
    ON transaction.trip_id = pp.trip_id
   AND transaction.transaction_type = 'fare_capture'
   AND transaction.idempotency_key = 'ride:' || pp.trip_id::text || ':capture'
  LEFT JOIN mobility.ledger_posting posting ON posting.transaction_id = transaction.id
  GROUP BY pp.id
),
payout_ledger AS (
  SELECT payout.id AS payout_instruction_id,
         COALESCE(SUM(posting.amount_kobo) FILTER (WHERE posting.direction = 'debit'), 0) AS debit_minor,
         COALESCE(SUM(posting.amount_kobo) FILTER (WHERE posting.direction = 'credit'), 0) AS credit_minor,
         COUNT(posting.id) > 0 AS has_postings
  FROM mobility.driver_payout_instruction payout
  JOIN mobility.ledger_transaction transaction
    ON transaction.trip_id = payout.trip_id
   AND transaction.transaction_type = 'payout_settlement'
   AND transaction.idempotency_key = 'ride:' || payout.trip_id::text || ':payout:' || payout.id::text
  LEFT JOIN mobility.ledger_posting posting ON posting.transaction_id = transaction.id
  GROUP BY payout.id
),
internal_items AS (
  SELECT context.import_id, context.period_end, context.settlement_grace,
         'collection'::text AS entry_kind, pp.provider_reference,
         pp.id AS provider_payment_id, NULL::uuid AS payout_instruction_id,
         pp.currency, pp.amount_kobo AS expected_gross_minor,
         settlement.provider_fee_kobo AS expected_fee_minor,
         pp.amount_kobo - settlement.provider_fee_kobo AS expected_net_minor,
         pp.state::text AS internal_state,
         COALESCE(pp.settled_at, pp.captured_at, pp.created_at) AS internal_occurred_at,
         pp.verified_at IS NOT NULL AND EXISTS (
           SELECT 1 FROM mobility.provider_webhook_event event
           WHERE event.provider = pp.provider AND event.provider_reference = pp.provider_reference
             AND event.signature_valid AND event.processed_at IS NOT NULL
             AND event.processing_error IS NULL
         ) AS verification_evidenced,
         COALESCE(ledger.has_postings, false) AND ledger.debit_minor = ledger.credit_minor
           AND ledger.debit_minor > 0 AS ledger_balanced
  FROM import_context context
  JOIN mobility.provider_payment_settlement_scope scope
    ON scope.merchant_account_id = context.merchant_account_id
  JOIN mobility.provider_payment pp ON pp.id = scope.provider_payment_id AND pp.provider = context.provider
  JOIN mobility.trip_settlement settlement ON settlement.trip_id = pp.trip_id
  LEFT JOIN collection_ledger ledger ON ledger.provider_payment_id = pp.id
  WHERE COALESCE(pp.settled_at, pp.captured_at, pp.created_at)
        BETWEEN context.period_start - context.settlement_grace AND context.period_end

  UNION ALL

  SELECT context.import_id, context.period_end, context.settlement_grace,
         'payout'::text, payout.provider_transfer_reference, pp.id, payout.id,
         payout.currency, -payout.amount_kobo, 0::bigint, -payout.amount_kobo,
         payout.state::text, COALESCE(payout.settled_at, payout.submitted_at, payout.created_at),
         EXISTS (
           SELECT 1 FROM mobility.provider_webhook_event event
           WHERE event.provider = payout.provider AND event.provider_reference = payout.provider_transfer_reference
             AND event.signature_valid AND event.processed_at IS NOT NULL
             AND event.processing_error IS NULL
         ) AS verification_evidenced,
         COALESCE(ledger.has_postings, false) AND ledger.debit_minor = ledger.credit_minor
           AND ledger.debit_minor > 0 AS ledger_balanced
  FROM import_context context
  JOIN mobility.provider_payment_settlement_scope scope
    ON scope.merchant_account_id = context.merchant_account_id
  JOIN mobility.provider_payment pp ON pp.id = scope.provider_payment_id AND pp.provider = context.provider
  JOIN mobility.driver_payout_instruction payout ON payout.trip_id = pp.trip_id AND payout.provider = context.provider
  LEFT JOIN payout_ledger ledger ON ledger.payout_instruction_id = payout.id
  WHERE COALESCE(payout.settled_at, payout.submitted_at, payout.created_at)
        BETWEEN context.period_start - context.settlement_grace AND context.period_end
),
joined AS (
  SELECT COALESCE(provider.import_id, internal.import_id) AS import_id,
         provider.provider_row_id::text AS provider_row_id,
         internal.provider_payment_id::text AS provider_payment_id,
         internal.payout_instruction_id::text AS payout_instruction_id,
         COALESCE(provider.entry_kind, internal.entry_kind) AS entry_kind,
         COALESCE(provider.provider_reference, internal.provider_reference) AS provider_reference,
         provider.currency AS reported_currency, internal.currency AS expected_currency,
         provider.gross_minor AS reported_gross_minor, internal.expected_gross_minor,
         provider.fee_minor AS reported_fee_minor, internal.expected_fee_minor,
         provider.net_minor AS reported_net_minor, internal.expected_net_minor,
         provider.provider_final_state, provider.provider_final_status,
         provider.duplicate_reference_count, internal.internal_state,
         internal.internal_occurred_at, internal.verification_evidenced, internal.ledger_balanced,
         internal.period_end, internal.settlement_grace,
         CASE
           WHEN provider.entry_kind = 'collection' THEN EXISTS (
             SELECT 1 FROM mobility.provider_payment pp
             WHERE pp.provider = provider.provider AND pp.provider_reference = provider.provider_reference
           )
           WHEN provider.entry_kind = 'payout' THEN EXISTS (
             SELECT 1 FROM mobility.driver_payout_instruction payout
             JOIN mobility.provider_payment pp ON pp.trip_id = payout.trip_id
             WHERE payout.provider = provider.provider
               AND payout.provider_transfer_reference = provider.provider_reference
           )
           ELSE false
         END AS unscoped_internal_present
  FROM provider_rows provider
  FULL OUTER JOIN internal_items internal
    ON internal.import_id = provider.import_id
   AND internal.entry_kind = provider.entry_kind
   AND internal.provider_reference = provider.provider_reference
)
SELECT * FROM joined ORDER BY entry_kind, provider_reference, provider_row_id NULLS LAST
"""


def severity_for(classification: str) -> str:
    if classification in {"ledger_imbalance", "unverified_financial_state", "illegal_state_transition", "amount_mismatch", "currency_mismatch", "net_mismatch"}:
        return "critical"
    if classification in {"expected_held_payout", "expected_provider_pending", "timing_difference"}:
        return "info"
    return "warning"


def classify_row(row: Mapping[str, Any], as_of: datetime) -> ClassifiedRow:
    provider_row_id = row["provider_row_id"]
    provider_payment_id = row["provider_payment_id"]
    payout_instruction_id = row["payout_instruction_id"]
    entry_kind = str(row["entry_kind"])
    provider_reference = str(row["provider_reference"])
    duplicate_count = int(row["duplicate_reference_count"] or 0)
    internal_state = row["internal_state"]
    provider_state = row["provider_final_state"]
    if provider_row_id is not None and duplicate_count > 1:
        classification = "duplicate_reference"
    elif provider_row_id is not None and provider_payment_id is None and payout_instruction_id is None:
        if entry_kind in {"refund", "chargeback", "adjustment"}:
            classification = "unsupported_provider_entry"
        elif bool(row["unscoped_internal_present"]):
            classification = "internal_scope_missing"
        else:
            classification = "provider_only"
    elif provider_row_id is None:
        occurred_at = row["internal_occurred_at"]
        period_end = row["period_end"]
        settlement_grace = row["settlement_grace"]
        if entry_kind == "payout" and internal_state in {"held", "queued"}:
            classification = "expected_held_payout"
        elif entry_kind == "collection" and internal_state in {"created", "authorisation_pending", "authorised", "capture_pending"}:
            classification = "expected_provider_pending"
        elif occurred_at is not None and period_end is not None and settlement_grace is not None and occurred_at >= period_end - settlement_grace and as_of <= period_end + settlement_grace:
            classification = "timing_difference"
        else:
            classification = "internal_only"
    elif not bool(row["verification_evidenced"]) and internal_state in {"captured", "settlement_pending", "settled"}:
        classification = "unverified_financial_state"
    elif not bool(row["ledger_balanced"]) and internal_state in {"captured", "settlement_pending", "settled"}:
        classification = "ledger_imbalance"
    elif row["reported_currency"] != row["expected_currency"]:
        classification = "currency_mismatch"
    elif int(row["reported_gross_minor"]) != int(row["expected_gross_minor"]):
        classification = "amount_mismatch"
    elif int(row["reported_fee_minor"]) != int(row["expected_fee_minor"]):
        classification = "fee_mismatch"
    elif int(row["reported_net_minor"]) != int(row["expected_net_minor"]):
        classification = "net_mismatch"
    elif entry_kind == "collection" and provider_state == "settled" and internal_state not in {"captured", "settlement_pending", "settled"}:
        classification = "illegal_state_transition"
    elif entry_kind == "payout" and provider_state == "settled" and internal_state != "settled":
        classification = "illegal_state_transition"
    elif entry_kind == "collection" and provider_state in {"failed", "reversed"} and internal_state in {"captured", "settlement_pending", "settled"}:
        classification = "illegal_state_transition"
    elif entry_kind == "payout" and provider_state in {"failed", "reversed"} and internal_state == "settled":
        classification = "illegal_state_transition"
    elif provider_state == "pending" and internal_state in {"captured", "settlement_pending"}:
        classification = "expected_provider_pending"
    else:
        classification = "matched"
    facts = {
        "entry_kind": entry_kind,
        "provider_final_state": provider_state,
        "provider_final_status": row["provider_final_status"],
        "internal_state": internal_state,
        "duplicate_reference_count": duplicate_count,
        "verification_evidenced": row["verification_evidenced"],
        "ledger_balanced": row["ledger_balanced"],
        "unscoped_internal_present": row["unscoped_internal_present"],
    }
    return ClassifiedRow(
        provider_row_id=str(provider_row_id) if provider_row_id else None,
        provider_payment_id=str(provider_payment_id) if provider_payment_id else None,
        payout_instruction_id=str(payout_instruction_id) if payout_instruction_id else None,
        entry_kind=entry_kind,
        provider_reference=provider_reference,
        classification=classification,
        severity=severity_for(classification),
        reported_currency=str(row["reported_currency"]) if row["reported_currency"] else None,
        expected_currency=str(row["expected_currency"]) if row["expected_currency"] else None,
        reported_gross_minor=int(row["reported_gross_minor"]) if row["reported_gross_minor"] is not None else None,
        expected_gross_minor=int(row["expected_gross_minor"]) if row["expected_gross_minor"] is not None else None,
        reported_fee_minor=int(row["reported_fee_minor"]) if row["reported_fee_minor"] is not None else None,
        expected_fee_minor=int(row["expected_fee_minor"]) if row["expected_fee_minor"] is not None else None,
        reported_net_minor=int(row["reported_net_minor"]) if row["reported_net_minor"] is not None else None,
        expected_net_minor=int(row["expected_net_minor"]) if row["expected_net_minor"] is not None else None,
        facts=facts,
    )


def exception_fingerprint(run_id: str, item: ClassifiedRow) -> bytes:
    material = {
        "reconciliation_run_id": run_id,
        "entry_kind": item.entry_kind,
        "provider_reference": item.provider_reference,
        "classification": item.classification,
        "provider_row_id": item.provider_row_id,
        "provider_payment_id": item.provider_payment_id,
        "payout_instruction_id": item.payout_instruction_id,
        "reported_currency": item.reported_currency,
        "expected_currency": item.expected_currency,
        "reported_gross_minor": item.reported_gross_minor,
        "expected_gross_minor": item.expected_gross_minor,
        "reported_fee_minor": item.reported_fee_minor,
        "expected_fee_minor": item.expected_fee_minor,
        "reported_net_minor": item.reported_net_minor,
        "expected_net_minor": item.expected_net_minor,
        "facts": item.facts,
    }
    return hashlib.sha256(canonical_json(material)).digest()


def create_summary(rows: Sequence[ClassifiedRow]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    expected_net: dict[str, int] = {}
    reported_net: dict[str, int] = {}
    for item in rows:
        counts[item.classification] = counts.get(item.classification, 0) + 1
        expected_net[item.classification] = expected_net.get(item.classification, 0) + (item.expected_net_minor or 0)
        reported_net[item.classification] = reported_net.get(item.classification, 0) + (item.reported_net_minor or 0)
    unexplained = sum(count for label, count in counts.items() if label in UNEXPLAINED_CLASSES)
    return {
        "classification_counts": dict(sorted(counts.items())),
        "expected_net_minor_by_class": dict(sorted(expected_net.items())),
        "reported_net_minor_by_class": dict(sorted(reported_net.items())),
        "unexplained_exception_count": unexplained,
        "row_count": len(rows),
    }


def load_completed_result(connection: psycopg.Connection[dict[str, Any]], import_id: str, classifier_version: str) -> dict[str, Any] | None:
    result = connection.execute(
        """
        SELECT id::text, as_of, completed_at, encode(result_digest, 'hex') AS result_digest, result_summary
        FROM mobility.settlement_reconciliation_run
        WHERE import_id = %s::uuid AND classifier_version = %s AND completed_at IS NOT NULL
        """,
        (import_id, classifier_version),
    ).fetchone()
    if result is None:
        return None
    summary = dict(result["result_summary"])
    summary.update(
        {
            "reconciliation_run_id": str(result["id"]),
            "as_of": result["as_of"].isoformat(),
            "completed_at": result["completed_at"].isoformat(),
            "result_digest": str(result["result_digest"]),
            "idempotent": True,
        }
    )
    return summary


def mark_reconciliation_failure(
    connection: psycopg.Connection[dict[str, Any]], import_id: str, classifier_version: str, failure_code: str
) -> None:
    """Persist a bounded operational failure code only after the classifier transaction rolls back."""
    with connection.transaction():
        connection.execute(
            """
            UPDATE mobility.settlement_import
            SET state = 'failed', completed_at = NULL, failure_code = %s, updated_at = now()
            WHERE id = %s::uuid AND state IN ('staged', 'reconciling')
            """,
            (failure_code[:128], import_id),
        )
        connection.execute(
            """
            UPDATE mobility.settlement_reconciliation_run
            SET failure_code = %s
            WHERE import_id = %s::uuid AND classifier_version = %s AND completed_at IS NULL
            """,
            (failure_code[:128], import_id, classifier_version),
        )


def reconcile_import(
    connection: psycopg.Connection[dict[str, Any]],
    import_id: str,
    classifier_version: str,
    as_of: datetime,
    requested_by: int | None,
) -> dict[str, Any]:
    if not re.fullmatch(r"^[a-z0-9][a-z0-9_.-]{2,80}$", classifier_version):
        raise ReconciliationError("classifier version is outside the allowed identifier format")
    parse_uuid(import_id, "import ID")
    try:
        with connection.transaction():
            prior = load_completed_result(connection, import_id, classifier_version)
            if prior is not None:
                return prior
            imported = connection.execute(
                """
                SELECT id::text, state::text
                FROM mobility.settlement_import
                WHERE id = %s::uuid
                FOR UPDATE
                """,
                (import_id,),
            ).fetchone()
            if imported is None:
                raise ReconciliationStateError("settlement import is not found")
            if imported["state"] not in {"staged", "reconciling"}:
                raise ReconciliationStateError(f"settlement import cannot reconcile from state {imported['state']}")
            existing = connection.execute(
                """
                SELECT id::text, completed_at
                FROM mobility.settlement_reconciliation_run
                WHERE import_id = %s::uuid AND classifier_version = %s
                FOR UPDATE
                """,
                (import_id, classifier_version),
            ).fetchone()
            if existing is not None and existing["completed_at"] is not None:
                completed = load_completed_result(connection, import_id, classifier_version)
                if completed is None:
                    raise ReconciliationStateError("completed reconciliation result could not be loaded")
                return completed
            if existing is None:
                created = connection.execute(
                    """
                    INSERT INTO mobility.settlement_reconciliation_run (
                      import_id, classifier_version, as_of, requested_by
                    ) VALUES (%s::uuid,%s,%s,%s)
                    RETURNING id::text
                    """,
                    (import_id, classifier_version, as_of, requested_by),
                ).fetchone()
                if created is None:
                    raise ReconciliationStateError("could not create reconciliation run")
                reconciliation_run_id = str(created["id"])
            else:
                reconciliation_run_id = str(existing["id"])
            connection.execute(
                "UPDATE mobility.settlement_import SET state = 'reconciling', updated_at = now() WHERE id = %s::uuid",
                (import_id,),
            )
            rows = connection.execute(CLASSIFICATION_QUERY, (import_id,)).fetchall()
            classified = [classify_row(row, as_of) for row in rows]
            for item in classified:
                if item.classification == "matched":
                    continue
                fingerprint = exception_fingerprint(reconciliation_run_id, item)
                connection.execute(
                    """
                    INSERT INTO mobility.settlement_reconciliation_exception (
                      reconciliation_run_id, exception_fingerprint, exception_class, severity,
                      provider_row_id, provider_payment_id, payout_instruction_id,
                      provider_reference, currency, expected_gross_minor, reported_gross_minor,
                      expected_fee_minor, reported_fee_minor, expected_net_minor, reported_net_minor,
                      detected_facts
                    ) VALUES (
                      %s::uuid,%s,%s::mobility.settlement_exception_class,%s,
                      %s::uuid,%s::uuid,%s::uuid,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb
                    ) ON CONFLICT (reconciliation_run_id, exception_fingerprint) DO NOTHING
                    """,
                    (
                        reconciliation_run_id,
                        fingerprint,
                        item.classification,
                        item.severity,
                        item.provider_row_id,
                        item.provider_payment_id,
                        item.payout_instruction_id,
                        item.provider_reference,
                        item.expected_currency or item.reported_currency,
                        item.expected_gross_minor,
                        item.reported_gross_minor,
                        item.expected_fee_minor,
                        item.reported_fee_minor,
                        item.expected_net_minor,
                        item.reported_net_minor,
                        json.dumps(item.facts, sort_keys=True, separators=(",", ":")),
                    ),
                )
            summary = create_summary(classified)
            digest_input = [
                {
                    "provider_row_id": item.provider_row_id,
                    "provider_payment_id": item.provider_payment_id,
                    "payout_instruction_id": item.payout_instruction_id,
                    "entry_kind": item.entry_kind,
                    "provider_reference": item.provider_reference,
                    "classification": item.classification,
                    "severity": item.severity,
                    "reported_net_minor": item.reported_net_minor,
                    "expected_net_minor": item.expected_net_minor,
                }
                for item in classified
            ]
            result_digest = hashlib.sha256(canonical_json(digest_input)).digest()
            connection.execute(
                """
                UPDATE mobility.settlement_reconciliation_run
                SET completed_at = now(), result_digest = %s, result_summary = %s::jsonb,
                    failure_code = NULL
                WHERE id = %s::uuid
                """,
                (result_digest, json.dumps(summary, sort_keys=True, separators=(",", ":")), reconciliation_run_id),
            )
            connection.execute(
                """
                UPDATE mobility.settlement_import
                SET state = 'reconciled', completed_at = COALESCE(completed_at, now()),
                    failure_code = NULL, updated_at = now()
                WHERE id = %s::uuid
                """,
                (import_id,),
            )
            return {
                **summary,
                "reconciliation_run_id": reconciliation_run_id,
                "as_of": as_of.isoformat(),
                "result_digest": result_digest.hex(),
                "idempotent": False,
            }
    except Exception as error:
        if isinstance(error, (ManifestValidationError, ReconciliationStateError, ReconciliationError)):
            raise
        failure_code = f"classifier_{error.__class__.__name__.lower()}"
        try:
            mark_reconciliation_failure(connection, import_id, classifier_version, failure_code)
        except psycopg.Error as persistence_error:
            raise ReconciliationError(
                f"reconciliation transaction failed and failure status could not be persisted: {persistence_error.__class__.__name__}"
            ) from error
        raise ReconciliationError(f"reconciliation transaction failed: {error.__class__.__name__}") from error


def write_summary(path: Path | None, summary: Mapping[str, Any]) -> None:
    if path is None:
        return
    serialized = json.dumps(summary, sort_keys=True, separators=(",", ":")) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(serialized, encoding="utf-8")


def parse_as_of(value: str | None) -> datetime:
    return parse_timestamp(value, "as-of") if value else datetime.now(timezone.utc)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read-only settlement reconciliation runner")
    parser.add_argument(
        "--database-url",
        default=os.getenv("SETTLEMENT_RECONCILIATION_DATABASE_URL", ""),
        help="PostgreSQL URL; normally supplied through SETTLEMENT_RECONCILIATION_DATABASE_URL",
    )
    parser.add_argument("--normalizer-version", default=NORMALIZER_VERSION)
    parser.add_argument("--classifier-version", default=CLASSIFIER_VERSION)
    parser.add_argument("--requested-by", type=int)
    parser.add_argument("--resilience-run-id")
    parser.add_argument("--summary-file", type=Path)
    commands = parser.add_subparsers(dest="command", required=True)
    stage = commands.add_parser("stage", help="validate and stage a report manifest")
    stage.add_argument("--manifest", required=True, type=Path)
    stage.add_argument("--artifact-file", required=True, type=Path)
    reconcile = commands.add_parser("reconcile", help="classify a staged import")
    reconcile.add_argument("--import-id", required=True)
    reconcile.add_argument("--as-of")
    run = commands.add_parser("run", help="stage then reconcile a report manifest")
    run.add_argument("--manifest", required=True, type=Path)
    run.add_argument("--artifact-file", required=True, type=Path)
    run.add_argument("--as-of")
    return parser


def execute(args: argparse.Namespace) -> dict[str, Any]:
    database_url = require_database_url(args.database_url)
    requested_by = optional_user_id(args.requested_by)
    resilience_run_id = validate_resilience_run_id(args.resilience_run_id)
    with psycopg.connect(database_url, row_factory=dict_row, autocommit=False) as connection:
        if args.command == "stage":
            manifest = load_manifest(args.manifest)
            verify_artifact(args.artifact_file, manifest)
            import_id, inserted = stage_report(connection, manifest, args.normalizer_version, resilience_run_id, requested_by)
            return {"import_id": import_id, "staged": inserted, "row_count": len(manifest.rows)}
        if args.command == "reconcile":
            return reconcile_import(connection, args.import_id, args.classifier_version, parse_as_of(args.as_of), requested_by)
        if args.command == "run":
            manifest = load_manifest(args.manifest)
            verify_artifact(args.artifact_file, manifest)
            import_id, inserted = stage_report(connection, manifest, args.normalizer_version, resilience_run_id, requested_by)
            summary = reconcile_import(connection, import_id, args.classifier_version, parse_as_of(args.as_of), requested_by)
            return {"import_id": import_id, "staged": inserted, **summary}
    raise ReconciliationError("unknown command")


def main(argv: Sequence[str] | None = None) -> int:
    configure_logging()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        summary = execute(args)
    except (ReconciliationError, psycopg.Error) as error:
        log_event("settlement.reconciliation.failed", error_class=error.__class__.__name__, reason=str(error))
        return 1
    log_event("settlement.reconciliation.completed", **summary)
    write_summary(args.summary_file, summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
