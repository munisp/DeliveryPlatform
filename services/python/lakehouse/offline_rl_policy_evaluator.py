#!/usr/bin/env python3
"""Fail-closed offline policy evaluation for non-authoritative operations.

This module deliberately cannot execute an action. It evaluates a proposed
contextual-bandit policy from immutable logged-decision JSONL records and emits
an approval recommendation only when policy, privacy, sample-size, and uplift
gates are met. It is not an online learning agent and has no access to payment,
vehicle-control, inventory, lifecycle, or safety APIs.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import pathlib
import sys
from collections import Counter
from dataclasses import dataclass
from typing import Any, Iterable

ALLOWED_DOMAINS = frozenset(
    {
        "dispatch_offer_ranking",
        "notification_timing",
        "support_queue_routing",
        "map_refresh_budget",
    }
)
FORBIDDEN_DOMAIN_TOKENS = frozenset(
    {
        "payment",
        "funds",
        "ledger",
        "tigerbeetle",
        "inventory",
        "vehicle_control",
        "immobilization",
        "safety",
        "lifecycle",
    }
)
REQUIRED_FIELDS = frozenset(
    {"decision_id", "domain", "logged_action", "logged_propensity", "reward", "candidate_actions"}
)


class PolicyEvaluationError(ValueError):
    """Raised when an offline evaluation violates a governance requirement."""


@dataclass(frozen=True)
class DecisionRecord:
    decision_id: str
    domain: str
    logged_action: str
    logged_propensity: float
    reward: float
    candidate_actions: tuple[str, ...]


@dataclass(frozen=True)
class EvaluationResult:
    domain: str
    records: int
    accepted_records: int
    logged_policy_reward: float
    proposed_policy_ips_reward: float
    uplift: float
    action_counts: dict[str, int]
    approved_for_shadow: bool
    reason: str


def _canonical_digest(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _validate_existing_audit_chain(path: pathlib.Path) -> str | None:
    previous_hash: str | None = None
    if not path.exists():
        return previous_hash
    with path.open("r", encoding="utf-8") as source:
        for line_number, raw_line in enumerate(source, start=1):
            if not raw_line.strip():
                raise PolicyEvaluationError(f"audit line {line_number}: blank records are forbidden")
            try:
                entry = json.loads(raw_line)
            except json.JSONDecodeError as exc:
                raise PolicyEvaluationError(f"audit line {line_number}: invalid JSON") from exc
            if not isinstance(entry, dict):
                raise PolicyEvaluationError(f"audit line {line_number}: record must be an object")
            entry_hash = entry.pop("entry_hash", None)
            if not isinstance(entry_hash, str) or entry_hash != _canonical_digest(entry):
                raise PolicyEvaluationError(f"audit line {line_number}: hash-chain integrity check failed")
            if entry.get("previous_entry_hash") != previous_hash:
                raise PolicyEvaluationError(f"audit line {line_number}: predecessor hash mismatch")
            previous_hash = entry_hash
    return previous_hash


def shadow_confidence(result: EvaluationResult, minimum_records: int) -> float:
    if minimum_records < 1 or result.records < 1:
        return 0.0
    coverage = min(1.0, result.accepted_records / result.records)
    sample = min(1.0, result.records / minimum_records)
    uplift_quality = min(1.0, max(0.0, result.uplift + 1.0) / 2.0)
    # This measures evaluation-data sufficiency only. It is not a probability of
    # operational success and must not be used to bypass domain safeguards.
    return round(coverage * sample * uplift_quality, 6)


def append_shadow_evaluation_audit(
    path: pathlib.Path,
    *,
    evaluation_id: str,
    action_priority: tuple[str, ...],
    minimum_records: int,
    result: EvaluationResult,
) -> dict[str, Any]:
    path.parent.mkdir(parents=True, exist_ok=True)
    previous_hash = _validate_existing_audit_chain(path)
    entry: dict[str, Any] = {
        "schema_version": 1,
        "evaluation_id": _require_non_empty_string(evaluation_id, "evaluation_id"),
        "recorded_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "previous_entry_hash": previous_hash,
        "domain": result.domain,
        "policy_digest": _canonical_digest({"action_priority": list(action_priority)}),
        "records": result.records,
        "accepted_records": result.accepted_records,
        "logged_policy_reward": result.logged_policy_reward,
        "proposed_policy_ips_reward": result.proposed_policy_ips_reward,
        "uplift": result.uplift,
        "confidence_score": shadow_confidence(result, minimum_records),
        "approved_for_shadow": result.approved_for_shadow,
        "reason": result.reason,
    }
    entry["entry_hash"] = _canonical_digest(entry)
    descriptor = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        payload = (json.dumps(entry, sort_keys=True) + "\n").encode("utf-8")
        while payload:
            written = os.write(descriptor, payload)
            if written <= 0:
                raise OSError("audit log write made no progress")
            payload = payload[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return entry


def _require_non_empty_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PolicyEvaluationError(f"{field} must be a non-empty string")
    return value.strip()


def _finite_float(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise PolicyEvaluationError(f"{field} must be numeric")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise PolicyEvaluationError(f"{field} must be numeric") from exc
    if not math.isfinite(number):
        raise PolicyEvaluationError(f"{field} must be finite")
    return number


def parse_record(raw: dict[str, Any]) -> DecisionRecord:
    missing = sorted(REQUIRED_FIELDS.difference(raw))
    if missing:
        raise PolicyEvaluationError(f"record missing required fields: {', '.join(missing)}")
    domain = _require_non_empty_string(raw["domain"], "domain")
    normalized_domain = domain.lower()
    if normalized_domain not in ALLOWED_DOMAINS:
        forbidden = next((token for token in FORBIDDEN_DOMAIN_TOKENS if token in normalized_domain), None)
        if forbidden:
            raise PolicyEvaluationError(f"domain {domain!r} is forbidden because it relates to {forbidden}")
        raise PolicyEvaluationError(f"domain {domain!r} is not allowlisted for offline decision support")
    propensity = _finite_float(raw["logged_propensity"], "logged_propensity")
    if not 0.0 < propensity <= 1.0:
        raise PolicyEvaluationError("logged_propensity must be in (0, 1]")
    reward = _finite_float(raw["reward"], "reward")
    if not -1.0 <= reward <= 1.0:
        raise PolicyEvaluationError("reward must be normalized to [-1, 1]")
    candidate_actions_raw = raw["candidate_actions"]
    if not isinstance(candidate_actions_raw, list) or not candidate_actions_raw:
        raise PolicyEvaluationError("candidate_actions must be a non-empty list")
    candidate_actions = tuple(_require_non_empty_string(action, "candidate_actions entry") for action in candidate_actions_raw)
    if len(set(candidate_actions)) != len(candidate_actions):
        raise PolicyEvaluationError("candidate_actions must not contain duplicates")
    logged_action = _require_non_empty_string(raw["logged_action"], "logged_action")
    if logged_action not in candidate_actions:
        raise PolicyEvaluationError("logged_action must occur in candidate_actions")
    return DecisionRecord(
        decision_id=_require_non_empty_string(raw["decision_id"], "decision_id"),
        domain=normalized_domain,
        logged_action=logged_action,
        logged_propensity=propensity,
        reward=reward,
        candidate_actions=candidate_actions,
    )


def load_records(path: pathlib.Path) -> list[DecisionRecord]:
    records: list[DecisionRecord] = []
    seen_ids: set[str] = set()
    with path.open("r", encoding="utf-8") as source:
        for line_number, raw_line in enumerate(source, start=1):
            if not raw_line.strip():
                continue
            try:
                raw = json.loads(raw_line)
            except json.JSONDecodeError as exc:
                raise PolicyEvaluationError(f"line {line_number}: invalid JSON") from exc
            if not isinstance(raw, dict):
                raise PolicyEvaluationError(f"line {line_number}: record must be a JSON object")
            record = parse_record(raw)
            if record.decision_id in seen_ids:
                raise PolicyEvaluationError(f"line {line_number}: duplicate decision_id {record.decision_id!r}")
            seen_ids.add(record.decision_id)
            records.append(record)
    if not records:
        raise PolicyEvaluationError("no decision records supplied")
    domains = {record.domain for record in records}
    if len(domains) != 1:
        raise PolicyEvaluationError("an evaluation input must contain exactly one allowlisted domain")
    return records


def proposed_action(record: DecisionRecord, action_priority: tuple[str, ...]) -> str:
    for action in action_priority:
        if action in record.candidate_actions:
            return action
    # The deterministic fallback intentionally makes no optimization claim.
    return record.candidate_actions[0]


def evaluate_offline_policy(
    records: Iterable[DecisionRecord],
    action_priority: tuple[str, ...],
    *,
    minimum_records: int,
    minimum_uplift: float,
) -> EvaluationResult:
    materialized = list(records)
    if minimum_records < 1:
        raise PolicyEvaluationError("minimum_records must be positive")
    if not action_priority:
        raise PolicyEvaluationError("action_priority must include at least one action")
    domain = materialized[0].domain
    action_counts: Counter[str] = Counter()
    logged_sum = 0.0
    ips_sum = 0.0
    accepted = 0
    for record in materialized:
        if record.domain != domain:
            raise PolicyEvaluationError("records contain mixed domains")
        proposed = proposed_action(record, action_priority)
        action_counts[proposed] += 1
        logged_sum += record.reward
        if proposed == record.logged_action:
            # Inverse propensity scoring is valid only for actions observed under
            # a logged randomized/known-propensity policy. No counterfactual data
            # is fabricated for unobserved actions.
            ips_sum += record.reward / record.logged_propensity
            accepted += 1
    logged_reward = logged_sum / len(materialized)
    ips_reward = ips_sum / len(materialized)
    uplift = ips_reward - logged_reward
    if len(materialized) < minimum_records:
        approved = False
        reason = f"insufficient sample size: {len(materialized)} < {minimum_records}"
    elif accepted == 0:
        approved = False
        reason = "no proposed actions overlap observed logged actions"
    elif uplift < minimum_uplift:
        approved = False
        reason = f"insufficient estimated uplift: {uplift:.6f} < {minimum_uplift:.6f}"
    else:
        approved = True
        reason = "eligible only for shadow evaluation; manual governance approval remains required"
    return EvaluationResult(
        domain=domain,
        records=len(materialized),
        accepted_records=accepted,
        logged_policy_reward=logged_reward,
        proposed_policy_ips_reward=ips_reward,
        uplift=uplift,
        action_counts=dict(sorted(action_counts.items())),
        approved_for_shadow=approved,
        reason=reason,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate a non-authoritative offline operational policy from logged JSONL decisions")
    parser.add_argument("--input", required=True, type=pathlib.Path, help="immutable logged-decision JSONL file")
    parser.add_argument(
        "--provenance-manifest",
        type=pathlib.Path,
        help="required sidecar manifest when --input is a real historical dispatch export",
    )
    parser.add_argument("--action-priority", required=True, help="comma-separated candidate-action priority; never an execution command")
    parser.add_argument("--minimum-records", type=int, default=1000)
    parser.add_argument("--minimum-uplift", type=float, default=0.01)
    parser.add_argument("--audit-log", required=True, type=pathlib.Path, help="append-only shadow-evaluation audit JSONL")
    parser.add_argument("--evaluation-id", required=True, help="unique governance evaluation identifier")
    arguments = parser.parse_args(argv)
    try:
        priority = tuple(part.strip() for part in arguments.action_priority.split(",") if part.strip())
        if arguments.provenance_manifest:
            try:
                from .real_dispatch_export_parser import load_real_dispatch_export
            except ImportError:  # Direct script execution from this directory.
                from real_dispatch_export_parser import load_real_dispatch_export
            records = load_real_dispatch_export(arguments.input, arguments.provenance_manifest).records
        else:
            records = load_records(arguments.input)
        result = evaluate_offline_policy(
            records,
            priority,
            minimum_records=arguments.minimum_records,
            minimum_uplift=arguments.minimum_uplift,
        )
        audit_entry = append_shadow_evaluation_audit(
            arguments.audit_log,
            evaluation_id=arguments.evaluation_id,
            action_priority=priority,
            minimum_records=arguments.minimum_records,
            result=result,
        )
    except (OSError, PolicyEvaluationError) as exc:
        print(f"offline_rl_policy_evaluation=FAIL reason={exc}", file=sys.stderr)
        return 2
    print(json.dumps({"offline_rl_policy_evaluation": "PASS", **result.__dict__, "audit_entry_hash": audit_entry["entry_hash"], "confidence_score": audit_entry["confidence_score"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
