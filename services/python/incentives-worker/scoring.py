"""Pure streak/rule evaluation for two-sided integrity incentives (R10).

This module mirrors the streak and reward-rule semantics owned by the TS side
(server/_core/integrityIncentives.ts, migration 0086_integrity_incentives.sql):

* Riders build standing from 'verified_manifest' events; drivers from
  'verified_completion' events. Matching events increment the current streak,
  refresh the longest streak, and stamp last_event_at.
* A 'violation' event resets the current streak to zero (the TS side records a
  companion 'streak_reset' event; the worker reports how many resets occurred).
* When an increment lands exactly on an active rule's threshold_streak for the
  same role, a reward is emitted with status 'pending' and the deterministic
  idempotency key "<event_id>:<rule_id>" so the TS writer can ON CONFLICT DO
  NOTHING and never double-grant.

No framework imports: this module must stay importable and testable without
FastAPI/pydantic installed.
"""

from __future__ import annotations

from typing import Any

RULES_VERSION = "integrity-incentives-v1"

VALID_ROLES = ("rider", "driver")

# Event type that increments the streak for each role (C1 contract).
INCREMENT_EVENT_BY_ROLE = {
    "rider": "verified_manifest",
    "driver": "verified_completion",
}

# Event types recognised by the ledger; anything else is ignored for streaks.
KNOWN_EVENT_TYPES = (
    "verified_manifest",
    "verified_completion",
    "violation",
    "streak_reset",
    "reward_granted",
)

DEFAULT_CURRENCY = "NGN"


class StreakEvaluationError(ValueError):
    """Raised when the streak state, rules, or events are malformed."""


def _require_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise StreakEvaluationError(f"{field} must be an integer")
    return value


def _validate_rule(rule: dict[str, Any], index: int) -> dict[str, Any]:
    if not isinstance(rule, dict):
        raise StreakEvaluationError(f"rules[{index}] must be an object")
    rule_id = rule.get("id")
    if not rule_id or not isinstance(rule_id, str):
        raise StreakEvaluationError(f"rules[{index}].id is required")
    role = rule.get("role")
    if role not in VALID_ROLES:
        raise StreakEvaluationError(f"rules[{index}].role must be one of {VALID_ROLES}")
    threshold = rule.get("threshold_streak")
    threshold = _require_int(threshold, f"rules[{index}].threshold_streak")
    if threshold <= 0:
        raise StreakEvaluationError(f"rules[{index}].threshold_streak must be > 0")
    reward_type = rule.get("reward_type")
    if reward_type not in ("credit", "badge", "priority"):
        raise StreakEvaluationError(
            f"rules[{index}].reward_type must be one of ('credit', 'badge', 'priority')"
        )
    amount_minor = rule.get("amount_minor")
    if reward_type == "credit":
        amount_minor = _require_int(amount_minor, f"rules[{index}].amount_minor")
        if amount_minor < 0:
            raise StreakEvaluationError(f"rules[{index}].amount_minor must be >= 0")
    elif amount_minor is not None:
        amount_minor = _require_int(amount_minor, f"rules[{index}].amount_minor")
    return {
        "id": rule_id,
        "role": role,
        "rule_key": str(rule.get("rule_key") or rule_id),
        "threshold_streak": threshold,
        "reward_type": reward_type,
        "amount_minor": amount_minor,
        "currency": str(rule.get("currency") or DEFAULT_CURRENCY),
        "active": bool(rule.get("active", True)),
    }


def _validate_event(event: dict[str, Any], index: int) -> dict[str, Any]:
    if not isinstance(event, dict):
        raise StreakEvaluationError(f"events[{index}] must be an object")
    event_type = event.get("event_type")
    if not isinstance(event_type, str) or not event_type:
        raise StreakEvaluationError(f"events[{index}].event_type is required")
    return {
        "id": event.get("id"),
        "event_type": event_type,
        "created_at": event.get("created_at"),
    }


def evaluate_events(
    streak_state: dict[str, Any],
    rules: list[dict[str, Any]],
    events: list[dict[str, Any]],
) -> dict[str, Any]:
    """Fold integrity events into a streak state and emit due rewards.

    Parameters
    ----------
    streak_state:
        {"role": "rider"|"driver", "current_streak": int,
         "longest_streak": int, "last_event_at": str|None}
        Missing streak counters default to zero (new subject).
    rules:
        Active/inactive reward rules; each mirrors integrity_reward_rules:
        {id, role, rule_key, threshold_streak, reward_type, amount_minor,
         currency, active}.
    events:
        Chronologically ordered integrity events: {id, event_type, created_at}.
        Events are applied in the order supplied; the caller owns ordering.
        Duplicate event ids inside one batch are applied once.

    Returns
    -------
    {"new_state": {...}, "rewards_to_grant": [...]} where each reward carries
    the deterministic idempotency key "<event_id>:<rule_id>".
    """

    if not isinstance(streak_state, dict):
        raise StreakEvaluationError("streak_state must be an object")
    role = streak_state.get("role")
    if role not in VALID_ROLES:
        raise StreakEvaluationError(f"streak_state.role must be one of {VALID_ROLES}")
    current_streak = _require_int(
        streak_state.get("current_streak", 0), "streak_state.current_streak"
    )
    longest_streak = _require_int(
        streak_state.get("longest_streak", 0), "streak_state.longest_streak"
    )
    if current_streak < 0 or longest_streak < 0:
        raise StreakEvaluationError("streak counters must be >= 0")
    longest_streak = max(longest_streak, current_streak)
    last_event_at = streak_state.get("last_event_at")

    checked_rules = [_validate_rule(rule, i) for i, rule in enumerate(rules)]
    applicable_rules = sorted(
        (rule for rule in checked_rules if rule["active"] and rule["role"] == role),
        key=lambda rule: (rule["threshold_streak"], rule["rule_key"], rule["id"]),
    )
    checked_events = [_validate_event(event, i) for i, event in enumerate(events)]

    increment_event = INCREMENT_EVENT_BY_ROLE[role]
    rewards_to_grant: list[dict[str, Any]] = []
    processed_event_ids: set[Any] = set()
    streak_resets = 0

    for event in checked_events:
        event_id = event["id"]
        if event_id is not None:
            if event_id in processed_event_ids:
                continue
            processed_event_ids.add(event_id)
        event_type = event["event_type"]
        if event_type == increment_event:
            current_streak += 1
            longest_streak = max(longest_streak, current_streak)
            if event["created_at"]:
                last_event_at = event["created_at"]
            for rule in applicable_rules:
                if rule["threshold_streak"] == current_streak:
                    rewards_to_grant.append(
                        {
                            "rule_id": rule["id"],
                            "rule_key": rule["rule_key"],
                            "reward_type": rule["reward_type"],
                            "amount_minor": rule["amount_minor"],
                            "currency": rule["currency"],
                            "status": "pending",
                            "event_id": event_id,
                            "idempotency_key": f"{event_id}:{rule['id']}",
                        }
                    )
        elif event_type == "violation":
            current_streak = 0
            streak_resets += 1
        # 'streak_reset', 'reward_granted' and unknown types have no streak effect.

    new_state = {
        "role": role,
        "current_streak": current_streak,
        "longest_streak": longest_streak,
        "last_event_at": last_event_at,
        "streak_resets": streak_resets,
    }
    return {"new_state": new_state, "rewards_to_grant": rewards_to_grant}
