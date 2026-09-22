"""Two-sided integrity incentives worker (R10).

Stateless computation service: the TS incentives router
(server/_core/integrityIncentives.ts) owns the ledger (integrity_streaks,
integrity_events, integrity_reward_rules, integrity_rewards) and calls
POST /incentives/evaluate fail-open after appending events. All streak/rule
semantics live in scoring.py (pure, framework-free) and mirror the TS logic
one-for-one so both sides agree on who earned what.

Default port: 8108 (verification-intelligence=8106, safety-engine=8107).
"""

from __future__ import annotations

import hmac
import logging
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_SERVICE_DIR = Path(__file__).resolve().parent
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))

_SHARED_DIR = _SERVICE_DIR.parent / "shared"
if str(_SHARED_DIR) not in sys.path:
    sys.path.insert(0, str(_SHARED_DIR))

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from config_validation import validate_boot_configuration
from switchos_resilience import MetricsRegistry
import scoring

validate_boot_configuration()

INTERNAL_SERVICE_TOKEN = os.environ.get("INTERNAL_SERVICE_TOKEN", "")
APP_VERSION = "1.0.0"
logger = logging.getLogger("incentives-worker")

app = FastAPI(title="DeliveryPlatform Incentives Worker", version=APP_VERSION)
_metrics = MetricsRegistry("incentives-worker", os.environ.get("SERVICE_VERSION", APP_VERSION))
app.middleware("http")(_metrics.fastapi_middleware())


class StreakState(BaseModel):
    role: str = Field(pattern=r"^(rider|driver)$")
    current_streak: int = Field(default=0, ge=0)
    longest_streak: int = Field(default=0, ge=0)
    last_event_at: str | None = Field(default=None, max_length=64)


class RewardRule(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    role: str = Field(pattern=r"^(rider|driver)$")
    rule_key: str = Field(min_length=1, max_length=128)
    threshold_streak: int = Field(gt=0)
    reward_type: str = Field(pattern=r"^(credit|badge|priority)$")
    amount_minor: int | None = Field(default=None, ge=0)
    currency: str = Field(default="NGN", min_length=3, max_length=8)
    active: bool = True


class IntegrityEvent(BaseModel):
    id: str | None = Field(default=None, max_length=128)
    event_type: str = Field(min_length=1, max_length=64)
    created_at: str | None = Field(default=None, max_length=64)


class EvaluateRequest(BaseModel):
    streak_state: StreakState
    rules: list[RewardRule] = Field(default_factory=list, max_length=200)
    events: list[IntegrityEvent] = Field(default_factory=list, max_length=500)


class EvaluateResponse(BaseModel):
    service: str
    rules_version: str
    evaluated_at: datetime
    new_state: dict[str, Any]
    rewards_to_grant: list[dict[str, Any]]
    metrics: dict[str, Any]


def require_internal(token: str | None) -> None:
    if not INTERNAL_SERVICE_TOKEN:
        raise HTTPException(status_code=503, detail="internal authentication is not configured")
    if not isinstance(token, str) or not token or not hmac.compare_digest(token, INTERNAL_SERVICE_TOKEN):
        raise HTTPException(status_code=401, detail="invalid internal service token")


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "incentives-worker",
        "version": APP_VERSION,
        "rules_version": scoring.RULES_VERSION,
    }


@app.get("/metrics")
async def metrics() -> PlainTextResponse:
    return PlainTextResponse(
        _metrics.render(), media_type="text/plain; version=0.0.4; charset=utf-8"
    )


@app.post("/incentives/evaluate", response_model=EvaluateResponse)
def evaluate(
    request: EvaluateRequest,
    x_internal_service_token: str | None = Header(default=None),
    x_trace_id: str | None = Header(default=None),
) -> EvaluateResponse:
    require_internal(x_internal_service_token)
    if not isinstance(x_trace_id, str):  # Header default when invoked directly
        x_trace_id = None
    trace_id = (x_trace_id or f"inc-{uuid.uuid4()}").strip()
    started = time.perf_counter()
    try:
        result = scoring.evaluate_events(
            request.streak_state.model_dump(),
            [rule.model_dump() for rule in request.rules],
            [event.model_dump() for event in request.events],
        )
    except scoring.StreakEvaluationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    logger.info(
        "incentives_event=evaluate_complete trace_id=%s role=%s events=%d rewards=%d duration_ms=%s",
        trace_id,
        request.streak_state.role,
        len(request.events),
        len(result["rewards_to_grant"]),
        elapsed_ms,
    )
    return EvaluateResponse(
        service="incentives-worker",
        rules_version=scoring.RULES_VERSION,
        evaluated_at=datetime.now(timezone.utc),
        new_state=result["new_state"],
        rewards_to_grant=result["rewards_to_grant"],
        metrics={
            "trace_id": trace_id,
            "request_duration_ms": elapsed_ms,
            "event_count": len(request.events),
            "rule_count": len(request.rules),
            "reward_count": len(result["rewards_to_grant"]),
        },
    )


if __name__ == "__main__":
    import uvicorn

    # UVICORN_WORKERS (default 2): workers > 1 requires the app as an import
    # string, so pass "main:app" — the service directory is on sys.path when
    # run as `python main.py` (see services/python/Dockerfile layout).
    uvicorn.run(
        "main:app",
        host=os.getenv("BIND_HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8108")),
        workers=int(os.getenv("UVICORN_WORKERS", "2")),
        timeout_keep_alive=30,
    )
