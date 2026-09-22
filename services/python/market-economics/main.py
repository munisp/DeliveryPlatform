"""R16 published market economics service (Wave D2).

FastAPI surface over report.py:
    GET  /healthz                          -> {"status": "ok"}
    GET  /metrics                          -> Prometheus text (shared registry)
    POST /reports/generate                 -> machine-readable + markdown report
    GET  /reports/{market_id}/latest       -> latest stored report for a market

Mutation routes require the X-Internal-Service-Token header (boot-validated).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

_SHARED_DIR = Path(__file__).resolve().parents[1] / "shared"
if str(_SHARED_DIR) not in sys.path:
    sys.path.insert(0, str(_SHARED_DIR))

from switchos_resilience import MetricsRegistry  # noqa: E402
from config_validation import validate_boot_configuration  # noqa: E402
import report  # noqa: E402

validate_boot_configuration()

INTERNAL_SERVICE_TOKEN = os.environ.get("INTERNAL_SERVICE_TOKEN", "")
SERVICE_VERSION = os.environ.get("SERVICE_VERSION", "1.0.0")

app = FastAPI(title="DeliveryPlatform Market Economics", version=SERVICE_VERSION)
_metrics = MetricsRegistry("market-economics", SERVICE_VERSION)
app.middleware("http")(_metrics.fastapi_middleware())

# Latest report per market, in-memory. This is a read-through cache of the
# most recent generated report; durability belongs to the caller persisting
# the machine-readable output (Worker Council / regulator distribution).
_latest_reports: dict[str, dict[str, Any]] = {}


class TripAggregate(BaseModel):
    gross_minor: int = Field(ge=0)
    take_minor: int = Field(ge=0, default=0)
    active_drivers: int = Field(ge=0, default=0)
    requests: int = Field(ge=0, default=0)


class ReportPeriod(BaseModel):
    start: str = Field(min_length=4, max_length=40)
    end: str = Field(min_length=4, max_length=40)


class GenerateReportRequest(BaseModel):
    market_id: str = Field(min_length=1, max_length=64)
    period: ReportPeriod
    trips: list[TripAggregate] = Field(max_length=1_000_000)
    published_take_rate_bps: int = Field(ge=0, le=10_000)
    fare_floor_minor: int = Field(ge=0)


class GenerateReportResponse(BaseModel):
    report: dict[str, Any]
    markdown: str


def require_internal(token: str | None) -> None:
    if not INTERNAL_SERVICE_TOKEN or token != INTERNAL_SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="invalid internal service token")


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok", "service": "market-economics"}


@app.get("/metrics")
async def metrics() -> Any:
    return PlainTextResponse(
        _metrics.render(), media_type="text/plain; version=0.0.4; charset=utf-8"
    )


@app.post("/reports/generate")
async def generate_report(
    request: GenerateReportRequest,
    x_internal_service_token: str | None = Header(default=None),
) -> GenerateReportResponse:
    require_internal(x_internal_service_token)
    try:
        generated = report.generate_market_report(request.model_dump())
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    _latest_reports[request.market_id] = generated
    return GenerateReportResponse(
        report=generated, markdown=report.render_markdown(generated)
    )


@app.get("/reports/{market_id}/latest")
async def latest_report(
    market_id: str,
    x_internal_service_token: str | None = Header(default=None),
) -> dict[str, Any]:
    require_internal(x_internal_service_token)
    stored = _latest_reports.get(market_id)
    if stored is None:
        raise HTTPException(status_code=404, detail="no report generated for market")
    return stored


if __name__ == "__main__":
    import uvicorn

    # UVICORN_WORKERS (default 2): workers > 1 requires the app as an import
    # string, so pass "main:app" — the service directory is on sys.path when
    # run as `python main.py` (see services/python/Dockerfile layout).
    uvicorn.run(
        "main:app",
        host=os.getenv("BIND_HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8110")),
        workers=int(os.getenv("UVICORN_WORKERS", "2")),
        timeout_keep_alive=30,
    )
