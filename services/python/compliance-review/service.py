from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from pathlib import Path
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse

import psycopg
import requests
from psycopg.rows import dict_row

import sys as _sys

_SHARED_DIR = Path(__file__).resolve().parents[1] / "shared"
if str(_SHARED_DIR) not in _sys.path:
    _sys.path.insert(0, str(_SHARED_DIR))

from switchos_resilience import ResilientSession


@dataclass(frozen=True)
class ComplianceConfig:
    database_url: str
    provider_name: str
    provider_verify_url: str
    provider_hmac_secret: bytes
    provider_ca_file: str | None
    operator_subject_key: str
    max_eligibility_days: int
    request_timeout_seconds: float

    @classmethod
    def from_environment(cls) -> "ComplianceConfig":
        database_url = os.getenv("DATABASE_URL", "").strip()
        provider_name = os.getenv("COMPLIANCE_PROVIDER_NAME", "").strip()
        provider_verify_url = os.getenv("COMPLIANCE_PROVIDER_VERIFY_URL", "").strip()
        provider_hmac_secret = os.getenv("COMPLIANCE_PROVIDER_HMAC_SECRET", "").encode("utf-8")
        provider_ca_file = os.getenv("COMPLIANCE_PROVIDER_CA_FILE", "").strip() or None
        operator_subject_key = os.getenv("COMPLIANCE_OPERATOR_SUBJECT_KEY", "lagos-private-beta").strip()
        max_eligibility_days = int(os.getenv("COMPLIANCE_MAX_ELIGIBILITY_DAYS", "30"))
        request_timeout_seconds = float(os.getenv("COMPLIANCE_PROVIDER_TIMEOUT_SECONDS", "8"))
        parsed = urlparse(provider_verify_url)
        if not database_url:
            raise RuntimeError("DATABASE_URL must be explicitly configured")
        if not provider_name or not provider_verify_url or parsed.scheme != "https" or not parsed.netloc:
            raise RuntimeError("COMPLIANCE_PROVIDER_NAME and HTTPS COMPLIANCE_PROVIDER_VERIFY_URL must be explicitly configured")
        if len(provider_hmac_secret) < 32:
            raise RuntimeError("COMPLIANCE_PROVIDER_HMAC_SECRET must contain at least 32 bytes")
        if provider_ca_file and not Path(provider_ca_file).is_file():
            raise RuntimeError("COMPLIANCE_PROVIDER_CA_FILE must reference a readable CA bundle")
        if not operator_subject_key or max_eligibility_days < 1 or max_eligibility_days > 90 or request_timeout_seconds <= 0 or request_timeout_seconds > 30:
            raise RuntimeError("compliance configuration is outside safe bounds")
        return cls(database_url, provider_name, provider_verify_url, provider_hmac_secret, provider_ca_file, operator_subject_key, max_eligibility_days, request_timeout_seconds)


class ComplianceVerificationService:
    def __init__(self, config: ComplianceConfig):
        self.config = config
        self.http = ResilientSession(
            default_timeout=self.config.request_timeout_seconds,
            max_attempts=3,
            failure_threshold=5,
            reset_timeout_seconds=30.0,
        )
        self.http.verify = config.provider_ca_file if config.provider_ca_file else True

    def _connect(self):
        return psycopg.connect(self.config.database_url, row_factory=dict_row)

    def check(self) -> None:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT to_regclass('mobility.compliance_verification_review') AS review_table, to_regclass('mobility.compliance_requirement') AS requirement_table")
            row = cursor.fetchone()
            if not row or not row["review_table"] or not row["requirement_table"]:
                raise RuntimeError("Lagos compliance migration is not applied")

    @staticmethod
    def _canonical_json(value: dict[str, Any]) -> bytes:
        return json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")

    @staticmethod
    def _digest(value: bytes) -> bytes:
        return hashlib.sha256(value).digest()

    def _require_subject(self, cursor, subject_kind: str, subject_key: str) -> tuple[int | None, str | None]:
        if subject_kind == "driver":
            try:
                driver_id = int(subject_key)
            except ValueError as error:
                raise ValueError("driver subject_key must be an integer") from error
            cursor.execute("SELECT user_id FROM mobility.driver_profile WHERE user_id = %s", (driver_id,))
            if cursor.fetchone() is None:
                raise LookupError("driver profile was not found")
            return driver_id, None
        if subject_kind == "vehicle":
            cursor.execute("SELECT id::text, driver_user_id FROM mobility.vehicle WHERE id = %s::uuid", (subject_key,))
            row = cursor.fetchone()
            if row is None:
                raise LookupError("vehicle was not found")
            return int(row["driver_user_id"]), str(row["id"])
        if subject_kind == "operator":
            if subject_key != self.config.operator_subject_key:
                raise ValueError("operator evidence must use the configured operator subject key")
            return None, None
        raise ValueError("invalid compliance subject kind")

    def _require_active_requirement(self, cursor, subject_kind: str, evidence_type: str) -> dict[str, Any]:
        cursor.execute(
            """
            SELECT id::text, policy_version, requires_human_approval
            FROM mobility.compliance_requirement
            WHERE city_code = 'LAG' AND subject_kind = %s AND evidence_type = %s
              AND active = true AND effective_from <= NOW() AND (effective_to IS NULL OR effective_to > NOW())
            ORDER BY effective_from DESC LIMIT 1
            """,
            (subject_kind, evidence_type),
        )
        requirement = cursor.fetchone()
        if requirement is None:
            raise ValueError("evidence type is not an active Lagos compliance requirement")
        return requirement

    def submit_evidence(self, payload: dict[str, Any], actor_user_id: int | None) -> dict[str, Any]:
        subject_kind = str(payload.get("subject_kind", "")).strip()
        subject_key = str(payload.get("subject_key", "")).strip()
        evidence_type = str(payload.get("evidence_type", "")).strip()
        external_reference = str(payload.get("external_reference", "")).strip()
        verifier = str(payload.get("verifier", "")).strip()
        document_object_key = str(payload.get("document_object_key", "")).strip() or None
        issued_at = payload.get("issued_at")
        expires_at = payload.get("expires_at")
        if not subject_key or not evidence_type or not external_reference or not verifier or len(external_reference) > 160 or len(verifier) > 120:
            raise ValueError("subject, evidence type, external reference, and verifier are required")
        evidence_payload = {
            "subject_kind": subject_kind, "subject_key": subject_key, "evidence_type": evidence_type,
            "external_reference": external_reference, "verifier": verifier, "document_object_key": document_object_key,
            "issued_at": issued_at, "expires_at": expires_at,
        }
        digest = self._digest(self._canonical_json(evidence_payload))
        with self._connect() as connection, connection.cursor() as cursor:
            driver_id, vehicle_id = self._require_subject(cursor, subject_kind, subject_key)
            requirement = self._require_active_requirement(cursor, subject_kind, evidence_type)
            cursor.execute(
                """
                INSERT INTO mobility.compliance_evidence
                  (subject_kind, subject_key, evidence_type, verifier, external_reference, document_object_key, issued_at, expires_at, state, immutable_digest, verification_policy_version)
                VALUES (%s,%s,%s,%s,%s,%s,%s::timestamptz,%s::timestamptz,'pending',%s,%s)
                ON CONFLICT (subject_kind, subject_key, evidence_type, external_reference)
                DO UPDATE SET document_object_key = EXCLUDED.document_object_key, issued_at = EXCLUDED.issued_at,
                  expires_at = EXCLUDED.expires_at, immutable_digest = EXCLUDED.immutable_digest,
                  verification_policy_version = EXCLUDED.verification_policy_version,
                  state = CASE WHEN mobility.compliance_evidence.state IN ('rejected','expired','revoked') THEN 'pending'::mobility.compliance_state ELSE mobility.compliance_evidence.state END,
                  rejection_or_revocation_reason = CASE WHEN mobility.compliance_evidence.state IN ('rejected','expired','revoked') THEN NULL ELSE mobility.compliance_evidence.rejection_or_revocation_reason END
                RETURNING id::text, state::text
                """,
                (subject_kind, subject_key, evidence_type, verifier, external_reference, document_object_key, issued_at, expires_at, digest, requirement["policy_version"]),
            )
            evidence = cursor.fetchone()
            self._audit(cursor, evidence["id"], driver_id, vehicle_id, "submitted", "evidence submitted for verification", requirement["policy_version"], "operator" if actor_user_id else "system", actor_user_id, {"requires_human_approval": requirement["requires_human_approval"]})
            return {"evidence_id": evidence["id"], "state": evidence["state"], "requires_human_approval": requirement["requires_human_approval"]}

    def verify_evidence(self, evidence_id: str) -> dict[str, Any]:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT e.id::text, e.subject_kind, e.subject_key, e.evidence_type, e.external_reference,
                       e.immutable_digest, e.state::text, e.verification_policy_version,
                       r.requires_human_approval
                FROM mobility.compliance_evidence e
                JOIN mobility.compliance_requirement r ON r.city_code='LAG' AND r.subject_kind=e.subject_kind
                  AND r.evidence_type=e.evidence_type AND r.policy_version=e.verification_policy_version AND r.active=true
                WHERE e.id = %s::uuid FOR UPDATE
                """,
                (evidence_id,),
            )
            evidence = cursor.fetchone()
            if evidence is None:
                raise LookupError("compliance evidence was not found")
            if evidence["state"] == "verified":
                return {"evidence_id": evidence_id, "state": "verified", "idempotent": True}
            attempt_no = self._next_attempt(cursor, evidence_id)
            provider_request = {
                "evidence_id": evidence_id, "subject_kind": evidence["subject_kind"], "subject_key": evidence["subject_key"],
                "evidence_type": evidence["evidence_type"], "external_reference": evidence["external_reference"],
                "immutable_digest_sha256": bytes(evidence["immutable_digest"]).hex(),
            }
        body = self._canonical_json(provider_request)
        try:
            response = self.http.post(self.config.provider_verify_url, data=body, headers={"content-type": "application/json", "x-compliance-provider": self.config.provider_name}, timeout=self.config.request_timeout_seconds)
            response_body = response.content
            signature = response.headers.get("x-compliance-provider-signature", "")
            expected_signature = hmac.new(self.config.provider_hmac_secret, response_body, hashlib.sha256).hexdigest()
            if not signature or not hmac.compare_digest(signature, expected_signature):
                raise RuntimeError("provider response signature was invalid")
            parsed = response.json()
            outcome = str(parsed.get("outcome", "")).strip()
            provider_reference = str(parsed.get("reference", "")).strip() or None
            if outcome not in {"verified", "rejected", "manual_review"}:
                raise RuntimeError("provider returned an unsupported verification outcome")
            response_status = response.status_code
            response_digest = self._digest(response_body)
            error_code = None
        except (requests.RequestException, ValueError, RuntimeError) as error:
            outcome = "retryable_error"
            provider_reference = None
            response_status = None
            response_digest = None
            error_code = type(error).__name__
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT id::text, subject_kind, subject_key, evidence_type, verification_policy_version FROM mobility.compliance_evidence WHERE id=%s::uuid FOR UPDATE", (evidence_id,))
            current = cursor.fetchone()
            if current is None:
                raise LookupError("compliance evidence was not found")
            next_attempt_at = None if outcome != "retryable_error" else datetime.now(timezone.utc) + timedelta(seconds=min(3600, 30 * (2 ** min(attempt_no - 1, 6))))
            cursor.execute(
                """
                INSERT INTO mobility.compliance_verification_review
                  (evidence_id, provider_name, request_digest, provider_reference, outcome, response_status, response_digest, error_code, attempt_no, next_attempt_at, resolved_at)
                VALUES (%s::uuid,%s,%s,%s,%s,%s,%s,%s,%s,%s,CASE WHEN %s = 'retryable_error' THEN NULL ELSE NOW() END)
                """,
                (evidence_id, self.config.provider_name, self._digest(body), provider_reference, outcome, response_status, response_digest, error_code, attempt_no, next_attempt_at, outcome),
            )
            driver_id, vehicle_id = self._require_subject(cursor, current["subject_kind"], current["subject_key"])
            if outcome == "verified":
                if self._requires_human_approval(cursor, current):
                    cursor.execute("UPDATE mobility.compliance_evidence SET source_verified_at=NOW(), verification_reference=%s, rejection_or_revocation_reason=NULL WHERE id=%s::uuid", (provider_reference, evidence_id))
                    state = "pending_human_approval"
                    decision = "provider_verified"
                    reason = "external verification completed; human approval remains required"
                else:
                    cursor.execute("UPDATE mobility.compliance_evidence SET state='verified', source_verified_at=NOW(), verified_at=NOW(), verification_reference=%s, rejection_or_revocation_reason=NULL WHERE id=%s::uuid", (provider_reference, evidence_id))
                    state = "verified"
                    decision = "provider_verified"
                    reason = "external verification completed"
            elif outcome == "rejected":
                cursor.execute("UPDATE mobility.compliance_evidence SET state='rejected', rejection_or_revocation_reason='provider_rejected' WHERE id=%s::uuid", (evidence_id,))
                state = "rejected"
                decision = "provider_rejected"
                reason = "external verifier rejected evidence"
            elif outcome == "manual_review":
                cursor.execute("UPDATE mobility.compliance_evidence SET source_verified_at=NOW(), verification_reference=%s WHERE id=%s::uuid", (provider_reference, evidence_id))
                state = "pending_human_approval"
                decision = "provider_verified"
                reason = "external verifier requires human review"
            else:
                state = "pending"
                decision = "submitted"
                reason = "external verifier was unavailable; retry is scheduled"
            self._audit(cursor, evidence_id, driver_id, vehicle_id, decision, reason, current["verification_policy_version"], "provider" if outcome != "retryable_error" else "system", None, {"outcome": outcome, "attempt_no": attempt_no, "provider_reference": provider_reference, "error_code": error_code})
            if driver_id:
                eligibility = self._refresh_driver_eligibility(cursor, driver_id, current["verification_policy_version"])
                affected_driver_count = 1
            elif current["subject_kind"] == "operator":
                affected_driver_count = self._refresh_all_driver_eligibility(cursor, current["verification_policy_version"])
                eligibility = None
            else:
                affected_driver_count = 0
                eligibility = None
            return {"evidence_id": evidence_id, "state": state, "outcome": outcome, "attempt_no": attempt_no, "eligibility": eligibility, "affected_driver_count": affected_driver_count}

    def approve_evidence(self, evidence_id: str, reviewer_user_id: int, approved: bool, reason: str) -> dict[str, Any]:
        if reviewer_user_id <= 0 or not reason.strip() or len(reason) > 600:
            raise ValueError("reviewer_user_id and a bounded decision reason are required")
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT e.id::text, e.subject_kind, e.subject_key, e.verification_policy_version, e.state::text, r.requires_human_approval FROM mobility.compliance_evidence e JOIN mobility.compliance_requirement r ON r.city_code='LAG' AND r.subject_kind=e.subject_kind AND r.evidence_type=e.evidence_type AND r.policy_version=e.verification_policy_version AND r.active=true WHERE e.id=%s::uuid FOR UPDATE", (evidence_id,))
            evidence = cursor.fetchone()
            if evidence is None:
                raise LookupError("compliance evidence was not found")
            if not evidence["requires_human_approval"]:
                raise ValueError("evidence type does not require human approval")
            driver_id, vehicle_id = self._require_subject(cursor, evidence["subject_kind"], evidence["subject_key"])
            if approved:
                cursor.execute("UPDATE mobility.compliance_evidence SET state='verified', verified_by=%s, verified_at=NOW(), human_approved_at=NOW(), rejection_or_revocation_reason=NULL WHERE id=%s::uuid", (reviewer_user_id, evidence_id))
                decision, state = "human_approved", "verified"
            else:
                cursor.execute("UPDATE mobility.compliance_evidence SET state='rejected', verified_by=%s, verified_at=NOW(), rejection_or_revocation_reason=%s WHERE id=%s::uuid", (reviewer_user_id, reason.strip(), evidence_id))
                decision, state = "human_rejected", "rejected"
            self._audit(cursor, evidence_id, driver_id, vehicle_id, decision, reason.strip(), evidence["verification_policy_version"], "operator", reviewer_user_id, {})
            if driver_id:
                eligibility = self._refresh_driver_eligibility(cursor, driver_id, evidence["verification_policy_version"])
                affected_driver_count = 1
            elif evidence["subject_kind"] == "operator":
                affected_driver_count = self._refresh_all_driver_eligibility(cursor, evidence["verification_policy_version"])
                eligibility = None
            else:
                affected_driver_count = 0
                eligibility = None
            return {"evidence_id": evidence_id, "state": state, "eligibility": eligibility, "affected_driver_count": affected_driver_count}

    def get_driver_eligibility(self, driver_user_id: int) -> dict[str, Any]:
        if driver_user_id <= 0:
            raise ValueError("driver_user_id must be positive")
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT e.driver_user_id, e.eligible, e.eligible_until, e.exclusion_code, e.policy_version, e.version, p.state::text AS presence_state FROM mobility.driver_eligibility e JOIN mobility.driver_presence p ON p.driver_user_id=e.driver_user_id WHERE e.driver_user_id=%s", (driver_user_id,))
            row = cursor.fetchone()
            if row is None:
                raise LookupError("driver eligibility was not found")
            return {"driver_user_id": int(row["driver_user_id"]), "eligible": bool(row["eligible"]), "eligible_until": row["eligible_until"].isoformat() if row["eligible_until"] else None, "exclusion_code": row["exclusion_code"], "policy_version": row["policy_version"], "version": int(row["version"]), "presence_state": row["presence_state"]}

    def reconcile_expiry(self) -> dict[str, int]:
        affected_drivers: set[int] = set()
        expired_count = 0
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("UPDATE mobility.compliance_evidence SET state='expired', rejection_or_revocation_reason='evidence_expired' WHERE state='verified' AND expires_at IS NOT NULL AND expires_at <= NOW() RETURNING id::text, subject_kind, subject_key, verification_policy_version")
            for evidence in cursor.fetchall():
                driver_id, vehicle_id = self._require_subject(cursor, evidence["subject_kind"], evidence["subject_key"])
                self._audit(cursor, evidence["id"], driver_id, vehicle_id, "expired", "evidence expiry reached", evidence["verification_policy_version"], "system", None, {})
                if driver_id:
                    affected_drivers.add(driver_id)
                elif evidence["subject_kind"] == "operator":
                    cursor.execute("SELECT user_id FROM mobility.driver_profile")
                    affected_drivers.update(int(row["user_id"]) for row in cursor.fetchall())
                expired_count += 1
            for driver_id in affected_drivers:
                self._refresh_driver_eligibility(cursor, driver_id, "lagos-private-beta-v1")
        return {"expired_evidence": expired_count, "reconciled_drivers": len(affected_drivers)}

    def _next_attempt(self, cursor, evidence_id: str) -> int:
        cursor.execute("SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no FROM mobility.compliance_verification_review WHERE evidence_id=%s::uuid", (evidence_id,))
        return int(cursor.fetchone()["attempt_no"])

    def _requires_human_approval(self, cursor, evidence: dict[str, Any]) -> bool:
        cursor.execute("SELECT requires_human_approval FROM mobility.compliance_requirement WHERE city_code='LAG' AND subject_kind=%s AND evidence_type=%s AND policy_version=%s AND active=true", (evidence["subject_kind"], evidence["evidence_type"], evidence["verification_policy_version"]))
        row = cursor.fetchone()
        return bool(row and row["requires_human_approval"])

    def _refresh_all_driver_eligibility(self, cursor, policy_version: str) -> int:
        cursor.execute("SELECT user_id FROM mobility.driver_profile ORDER BY user_id")
        driver_ids = [int(row["user_id"]) for row in cursor.fetchall()]
        for driver_id in driver_ids:
            self._refresh_driver_eligibility(cursor, driver_id, policy_version)
        return len(driver_ids)

    def _refresh_driver_eligibility(self, cursor, driver_id: int, policy_version: str) -> dict[str, Any]:
        cursor.execute("SELECT id::text FROM mobility.vehicle WHERE driver_user_id=%s AND active=true ORDER BY updated_at DESC LIMIT 1", (driver_id,))
        vehicle = cursor.fetchone()
        cursor.execute("SELECT COUNT(*) AS total, COUNT(e.id) FILTER (WHERE e.state='verified' AND (e.expires_at IS NULL OR e.expires_at > NOW())) AS verified, MIN(e.expires_at) FILTER (WHERE e.state='verified' AND e.expires_at > NOW()) AS earliest_expiry FROM mobility.compliance_requirement r LEFT JOIN mobility.compliance_evidence e ON e.subject_kind='driver' AND e.subject_key=%s AND e.evidence_type=r.evidence_type AND e.verification_policy_version=r.policy_version WHERE r.city_code='LAG' AND r.subject_kind='driver' AND r.required_for_dispatch AND r.active", (str(driver_id),))
        driver_evidence = cursor.fetchone()
        vehicle_evidence = {"total": 0, "verified": 0, "earliest_expiry": None}
        if vehicle:
            cursor.execute("SELECT COUNT(*) AS total, COUNT(e.id) FILTER (WHERE e.state='verified' AND (e.expires_at IS NULL OR e.expires_at > NOW())) AS verified, MIN(e.expires_at) FILTER (WHERE e.state='verified' AND e.expires_at > NOW()) AS earliest_expiry FROM mobility.compliance_requirement r LEFT JOIN mobility.compliance_evidence e ON e.subject_kind='vehicle' AND e.subject_key=%s AND e.evidence_type=r.evidence_type AND e.verification_policy_version=r.policy_version WHERE r.city_code='LAG' AND r.subject_kind='vehicle' AND r.required_for_dispatch AND r.active", (vehicle["id"],))
            vehicle_evidence = cursor.fetchone()
        cursor.execute("SELECT COUNT(*) AS total, COUNT(e.id) FILTER (WHERE e.state='verified' AND (e.expires_at IS NULL OR e.expires_at > NOW())) AS verified FROM mobility.compliance_requirement r LEFT JOIN mobility.compliance_evidence e ON e.subject_kind='operator' AND e.subject_key=%s AND e.evidence_type=r.evidence_type AND e.verification_policy_version=r.policy_version WHERE r.city_code='LAG' AND r.subject_kind='operator' AND r.required_for_dispatch AND r.active", (self.config.operator_subject_key,))
        operator_evidence = cursor.fetchone()
        eligibility_ok = bool(vehicle) and int(driver_evidence["total"]) == int(driver_evidence["verified"]) and int(vehicle_evidence["total"]) == int(vehicle_evidence["verified"]) and int(operator_evidence["total"]) == int(operator_evidence["verified"])
        expiries = [value for value in (driver_evidence["earliest_expiry"], vehicle_evidence["earliest_expiry"]) if value]
        maximum = datetime.now(timezone.utc) + timedelta(days=self.config.max_eligibility_days)
        eligible_until = min([maximum, *expiries]) if eligibility_ok else None
        exclusion_code = None if eligibility_ok else "lagos_compliance_incomplete"
        cursor.execute("INSERT INTO mobility.driver_eligibility (driver_user_id, active_vehicle_id, eligible, eligible_until, exclusion_code, policy_version, version, updated_at) VALUES (%s,%s::uuid,%s,%s,%s,%s,1,NOW()) ON CONFLICT (driver_user_id) DO UPDATE SET active_vehicle_id=EXCLUDED.active_vehicle_id, eligible=EXCLUDED.eligible, eligible_until=EXCLUDED.eligible_until, exclusion_code=EXCLUDED.exclusion_code, policy_version=EXCLUDED.policy_version, version=mobility.driver_eligibility.version+1, updated_at=NOW()", (driver_id, vehicle["id"] if vehicle else None, eligibility_ok, eligible_until, exclusion_code, policy_version))
        if eligibility_ok:
            cursor.execute("UPDATE mobility.driver_presence SET state=CASE WHEN state IN ('pending_compliance','compliance_suspended') THEN 'offline'::mobility.driver_presence_state ELSE state END, updated_at=NOW(), version=version+1 WHERE driver_user_id=%s", (driver_id,))
            decision, reason = "eligibility_enabled", "all active Lagos compliance requirements are verified"
        else:
            cursor.execute("UPDATE mobility.driver_presence SET state=CASE WHEN state IN ('pending_compliance','offline','available','offer_pending') THEN 'compliance_suspended'::mobility.driver_presence_state ELSE state END, updated_at=NOW(), version=version+1 WHERE driver_user_id=%s", (driver_id,))
            decision, reason = "eligibility_disabled", "one or more active Lagos compliance requirements are incomplete, expired, or unapproved"
        self._audit(cursor, None, driver_id, vehicle["id"] if vehicle else None, decision, reason, policy_version, "system", None, {"driver_requirements": [int(driver_evidence["verified"]), int(driver_evidence["total"])], "vehicle_requirements": [int(vehicle_evidence["verified"]), int(vehicle_evidence["total"])], "operator_requirements": [int(operator_evidence["verified"]), int(operator_evidence["total"])], "eligible_until": eligible_until.isoformat() if eligible_until else None})
        return {"driver_user_id": driver_id, "eligible": eligibility_ok, "eligible_until": eligible_until.isoformat() if eligible_until else None, "exclusion_code": exclusion_code}

    @staticmethod
    def _audit(cursor, evidence_id: str | None, driver_id: int | None, vehicle_id: str | None, decision_kind: str, decision_reason: str, policy_version: str, actor_kind: str, actor_user_id: int | None, metadata: dict[str, Any]) -> None:
        cursor.execute("INSERT INTO mobility.compliance_decision_audit (evidence_id, driver_user_id, vehicle_id, decision_kind, decision_reason, policy_version, actor_kind, actor_user_id, metadata) VALUES (%s::uuid,%s,%s::uuid,%s,%s,%s,%s,%s,%s::jsonb)", (evidence_id, driver_id, vehicle_id, decision_kind, decision_reason, policy_version, actor_kind, actor_user_id, json.dumps(metadata, separators=(",", ":"), sort_keys=True)))
