from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import re
import sys
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from service import ComplianceConfig, ComplianceVerificationService

_SHARED_DIR = Path(__file__).resolve().parent.parent / "shared"
if str(_SHARED_DIR) not in sys.path:
    sys.path.insert(0, str(_SHARED_DIR))

from switchos_resilience import MetricsRegistry

INTERNAL_SERVICE_TOKEN = os.getenv("INTERNAL_SERVICE_TOKEN", "").strip()
service: ComplianceVerificationService | None = None
expiry_task: asyncio.Task | None = None
logger = logging.getLogger("compliance-review")
CORRELATION_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$")


def correlation_identifier(value: str | None) -> str:
    candidate = (value or "").strip()
    return candidate if CORRELATION_IDENTIFIER.fullmatch(candidate) else ""


def structured_log(event: str, *, request_id: str, resilience_run_id: str, **fields: object) -> None:
    payload: dict[str, object] = {
        "service": "compliance-review",
        "event": event,
        "request_id": request_id,
        "resilience_run_id": resilience_run_id or None,
    }
    for key, value in fields.items():
        if not CORRELATION_IDENTIFIER.fullmatch(key):
            continue
        if isinstance(value, str):
            payload[key] = value.replace("\x00", " ").replace("\n", " ").replace("\r", " ")[:256]
        elif isinstance(value, bool) or isinstance(value, int) or value is None:
            payload[key] = value
    logger.info(json.dumps(payload, sort_keys=True, separators=(",", ":")))


class EvidenceSubmission(BaseModel):
    subject_kind: str = Field(pattern="^(driver|vehicle|operator)$")
    subject_key: str = Field(min_length=1, max_length=128)
    evidence_type: str = Field(min_length=1, max_length=80)
    external_reference: str = Field(min_length=1, max_length=160)
    verifier: str = Field(min_length=1, max_length=120)
    document_object_key: str | None = Field(default=None, max_length=512)
    issued_at: str | None = None
    expires_at: str | None = None


class ApprovalDecision(BaseModel):
    reviewer_user_id: int = Field(gt=0)
    approved: bool
    reason: str = Field(min_length=1, max_length=600)


async def require_internal_access(x_internal_service_token: str | None = Header(default=None)) -> None:
    if len(INTERNAL_SERVICE_TOKEN) < 32:
        raise HTTPException(status_code=503, detail="internal authentication is not configured")
    if not x_internal_service_token or not hmac.compare_digest(x_internal_service_token, INTERNAL_SERVICE_TOKEN):
        raise HTTPException(status_code=401, detail="invalid internal service token")


async def run_expiry_reconciliation() -> None:
    assert service is not None
    while True:
        try:
            await asyncio.to_thread(service.reconcile_expiry)
        except Exception as error:
            logger.exception("compliance expiry reconciliation failed: %s", error)
        await asyncio.sleep(60)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global service, expiry_task
    if len(INTERNAL_SERVICE_TOKEN) < 32:
        raise RuntimeError("INTERNAL_SERVICE_TOKEN must be explicitly configured with at least 32 characters")
    service = ComplianceVerificationService(ComplianceConfig.from_environment())
    await asyncio.to_thread(service.check)
    expiry_task = asyncio.create_task(run_expiry_reconciliation())
    try:
        yield
    finally:
        if expiry_task is not None:
            expiry_task.cancel()
            try:
                await expiry_task
            except asyncio.CancelledError:
                pass


app = FastAPI(title="SwitchOS Lagos Compliance Review", version="1.0.0", lifespan=lifespan)
_metrics = MetricsRegistry("compliance-review", os.getenv("SERVICE_VERSION", "1.0.0"))
app.middleware("http")(_metrics.fastapi_middleware())


@app.get("/metrics")
async def metrics() -> Response:
    return Response(content=_metrics.render(), media_type="text/plain; version=0.0.4; charset=utf-8")



@app.middleware("http")
async def resilience_correlation_middleware(request: Request, call_next):
    request_id = correlation_identifier(request.headers.get("x-request-id")) or str(uuid.uuid4())
    resilience_run_id = correlation_identifier(request.headers.get("x-resilience-run-id"))
    response: Response = await call_next(request)
    response.headers["X-Request-Id"] = request_id
    if resilience_run_id:
        response.headers["X-Resilience-Run-Id"] = resilience_run_id
        structured_log("http.request.completed", request_id=request_id, resilience_run_id=resilience_run_id, method=request.method, path=request.url.path, status=response.status_code)
    return response


def current_service() -> ComplianceVerificationService:
    if service is None:
        raise HTTPException(status_code=503, detail="compliance verification service is not ready")
    return service


@app.get("/health")
async def health() -> dict[str, str]:
    try:
        await asyncio.to_thread(current_service().check)
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return {"status": "healthy", "service": "compliance-review"}


@app.post("/evidence", status_code=201)
async def submit_evidence(payload: EvidenceSubmission, x_internal_service_token: str | None = Header(default=None), x_actor_user_id: int | None = Header(default=None)):
    await require_internal_access(x_internal_service_token)
    try:
        return await asyncio.to_thread(current_service().submit_evidence, payload.model_dump(), x_actor_user_id)
    except (LookupError, ValueError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/evidence/{evidence_id}/verify")
async def verify_evidence(evidence_id: str, x_internal_service_token: str | None = Header(default=None)):
    await require_internal_access(x_internal_service_token)
    try:
        return await asyncio.to_thread(current_service().verify_evidence, evidence_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/evidence/{evidence_id}/approve")
async def approve_evidence(evidence_id: str, payload: ApprovalDecision, x_internal_service_token: str | None = Header(default=None)):
    await require_internal_access(x_internal_service_token)
    try:
        return await asyncio.to_thread(current_service().approve_evidence, evidence_id, payload.reviewer_user_id, payload.approved, payload.reason)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.get("/drivers/{driver_user_id}/eligibility")
async def driver_eligibility(driver_user_id: int, x_internal_service_token: str | None = Header(default=None)):
    await require_internal_access(x_internal_service_token)
    try:
        return await asyncio.to_thread(current_service().get_driver_eligibility, driver_user_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/reconcile-expiry")
async def reconcile_expiry(x_internal_service_token: str | None = Header(default=None)):
    await require_internal_access(x_internal_service_token)
    return await asyncio.to_thread(current_service().reconcile_expiry)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.getenv("BIND_HOST", "127.0.0.1"), port=int(os.getenv("PORT", "8125")))
