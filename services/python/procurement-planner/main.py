from __future__ import annotations

import hmac
import logging
import math
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from fastapi import FastAPI, Header, HTTPException, Response
from pydantic import BaseModel, Field

from config_validation import validate_boot_configuration
from durable_run_store import DurableRunStore
import maintenance

_SHARED_DIR = Path(__file__).resolve().parent.parent / "shared"
if str(_SHARED_DIR) not in sys.path:
    sys.path.insert(0, str(_SHARED_DIR))

from switchos_resilience import MetricsRegistry
validate_boot_configuration()

INTERNAL_SERVICE_TOKEN = os.getenv("INTERNAL_SERVICE_TOKEN", "").strip()
logger = logging.getLogger("switchos.procurement_planner")
APP_VERSION = "2026-07-09-procurement-closure-wave"
TRACE_ENABLED = os.getenv("LOCAL_COMMERCE_ENABLE_TRACING", "true").strip().lower() == "true"

app = FastAPI(title="switchos-procurement-planner", version=APP_VERSION)
_metrics = MetricsRegistry("procurement-planner", os.getenv("SERVICE_VERSION", APP_VERSION))
app.middleware("http")(_metrics.fastapi_middleware())


@app.get("/metrics")
async def metrics() -> Response:
    return Response(content=_metrics.render(), media_type="text/plain; version=0.0.4; charset=utf-8")

execution_store = DurableRunStore("procurement-planner")


@app.on_event("startup")
async def startup() -> None:
    execution_store.initialize()


class SupplierSignal(BaseModel):
    supplier_id: str = Field(min_length=1, max_length=128)
    supplier_name: str = Field(min_length=1, max_length=255)
    lead_time_hours: float = Field(default=24, ge=1, le=720)
    fill_rate: float = Field(default=0.92, ge=0, le=1)
    spoilage_risk: float = Field(default=0.05, ge=0, le=1)
    reliability_band: str = Field(default="stable", max_length=64)


class ReplenishmentSkuRequest(BaseModel):
    sku: str = Field(min_length=1, max_length=128)
    label: str | None = Field(default=None, max_length=255)
    category: str | None = Field(default=None, max_length=128)
    warehouse_id: int = Field(ge=1)
    warehouse_label: str = Field(min_length=1, max_length=255)
    zone_key: str | None = Field(default=None, max_length=128)
    current_available_units: float = Field(default=0, ge=0)
    current_reserved_units: float = Field(default=0, ge=0)
    current_inbound_units: float = Field(default=0, ge=0)
    forecast_units: float = Field(default=0, ge=0)
    recommended_restock_units: float = Field(default=0, ge=0)
    safety_stock_units: float = Field(default=0, ge=0)
    stockout_risk: str = Field(default="watch", max_length=64)
    supplier: SupplierSignal
    target_transfer_node_id: int | None = Field(default=None, ge=1)
    target_transfer_node_name: str | None = Field(default=None, max_length=255)


class ProcurementPlanRequest(BaseModel):
    city: str = Field(min_length=2, max_length=128)
    planning_horizon_hours: int = Field(default=48, ge=4, le=720)
    trigger: str = Field(default="network_health", min_length=2, max_length=128)
    requested_by: str = Field(default="logistics_control_tower", min_length=2, max_length=255)
    workflow_reason: str = Field(default="Protect fill rate and ETA honesty", min_length=3, max_length=500)
    skus: list[ReplenishmentSkuRequest] = Field(default_factory=list, min_length=1, max_length=200)


class SupplierHealthRequest(BaseModel):
    city: str = Field(min_length=2, max_length=128)
    suppliers: list[SupplierSignal] = Field(default_factory=list, min_length=1, max_length=200)


class ProcurementPlanItem(BaseModel):
    sku: str
    label: str | None
    warehouse_id: int
    warehouse_label: str
    supplier_id: str
    supplier_name: str
    recommended_units: float
    safety_stock_units: float
    lead_time_hours: float
    service_level: float
    risk_band: str
    action_mode: str
    narrative: str
    target_transfer_node_id: int | None = None
    target_transfer_node_name: str | None = None


class ProcurementPlanMetrics(BaseModel):
    trace_id: str
    request_duration_ms: float
    sku_count: int
    payload_chars: int
    critical_items: int
    transfer_items: int


class ProcurementPlanResponse(BaseModel):
    service: str
    generated_at: datetime
    city: str
    planning_horizon_hours: int
    approval_mode: str
    critical_items: int
    summary: str
    procurement_actions: list[ProcurementPlanItem]
    metrics: ProcurementPlanMetrics


class SupplierHealthItem(BaseModel):
    supplier_id: str
    supplier_name: str
    lead_time_hours: float
    fill_rate: float
    spoilage_risk: float
    reliability_band: str
    urgency: str
    narrative: str


class SupplierHealthResponse(BaseModel):
    service: str
    generated_at: datetime
    city: str
    resilience_band: str
    suppliers: list[SupplierHealthItem]
    summary: str
    metrics: dict[str, Any]


@app.get("/health")
def health() -> dict[str, Any]:
    try:
        execution_store.check()
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return {
        "status": "healthy",
        "service": "switchos-procurement-planner",
        "version": APP_VERSION,
        "ready": True,
        "modes": ["replenishment", "transfer", "supplier-health"],
    }


@app.post("/procurement/plan", response_model=ProcurementPlanResponse)
def procurement_plan(
    request: ProcurementPlanRequest,
    x_internal_service_token: str | None = Header(default=None),
    x_trace_id: str | None = Header(default=None),
) -> ProcurementPlanResponse:
    _require_internal_token(x_internal_service_token)
    trace_id = (x_trace_id or _trace_id()).strip()
    started = time.perf_counter()

    actions: list[ProcurementPlanItem] = []
    critical_items = 0
    transfer_items = 0
    for sku in request.skus:
        supplier_risk = max(0.0, 1 - sku.supplier.fill_rate) + sku.supplier.spoilage_risk
        low_cover = sku.current_available_units + sku.current_inbound_units < max(sku.forecast_units, sku.safety_stock_units)
        critical = sku.stockout_risk.lower() in {"critical", "fragile"} or (low_cover and supplier_risk >= 0.2)
        if critical:
            critical_items += 1
        action_mode = "purchase_order"
        if sku.target_transfer_node_id is not None:
            action_mode = "inter_node_transfer"
            transfer_items += 1
        service_level = 0.985 if critical else 0.95
        recommended_units = max(float(sku.recommended_restock_units), float(sku.safety_stock_units) - float(sku.current_inbound_units))
        recommended_units = round(max(recommended_units, 0), 2)
        narrative = (
            f"{sku.supplier.supplier_name} should cover {recommended_units:.0f} units for {sku.sku} into {sku.warehouse_label}; "
            f"lead time is {sku.supplier.lead_time_hours:.0f}h and fill rate is {sku.supplier.fill_rate:.0%}."
        )
        if action_mode == "inter_node_transfer" and sku.target_transfer_node_id is not None:
            narrative = (
                f"Shift {recommended_units:.0f} units of {sku.sku} from node {sku.target_transfer_node_id} to {sku.warehouse_label} "
                f"because supplier lead time of {sku.supplier.lead_time_hours:.0f}h is too slow for current risk."
            )
        actions.append(
            ProcurementPlanItem(
                sku=sku.sku,
                label=sku.label,
                warehouse_id=sku.warehouse_id,
                warehouse_label=sku.warehouse_label,
                supplier_id=sku.supplier.supplier_id,
                supplier_name=sku.supplier.supplier_name,
                recommended_units=recommended_units,
                safety_stock_units=round(sku.safety_stock_units, 2),
                lead_time_hours=round(sku.supplier.lead_time_hours, 2),
                service_level=service_level,
                risk_band="critical" if critical else sku.stockout_risk.lower(),
                action_mode=action_mode,
                narrative=narrative,
                target_transfer_node_id=sku.target_transfer_node_id,
                target_transfer_node_name=sku.target_transfer_node_name,
            )
        )

    approval_mode = "operator_review" if critical_items > 0 or transfer_items > 0 else "auto_queue"
    summary = (
        f"Generated {len(actions)} procurement actions for {request.city}; "
        f"{critical_items} are critical and {transfer_items} require inter-node transfer handling."
    )
    metrics = ProcurementPlanMetrics(
        trace_id=trace_id,
        request_duration_ms=round((time.perf_counter() - started) * 1000, 2),
        sku_count=len(request.skus),
        payload_chars=len(request.model_dump_json()),
        critical_items=critical_items,
        transfer_items=transfer_items,
    )
    _trace("procurement.plan_complete", metrics.model_dump())
    response = ProcurementPlanResponse(
        service="switchos-procurement-planner",
        generated_at=datetime.now(timezone.utc),
        city=request.city,
        planning_horizon_hours=request.planning_horizon_hours,
        approval_mode=approval_mode,
        critical_items=critical_items,
        summary=summary,
        procurement_actions=actions,
        metrics=metrics,
    )
    execution_store.record(
        "procurement_plan",
        trace_id,
        {"city": request.city, "planning_horizon_hours": request.planning_horizon_hours, "sku_count": len(request.skus), "trigger": request.trigger},
        {"approval_mode": response.approval_mode, "critical_items": response.critical_items, "action_count": len(response.procurement_actions)},
    )
    return response


@app.post("/procurement/supplier-health", response_model=SupplierHealthResponse)
def supplier_health(
    request: SupplierHealthRequest,
    x_internal_service_token: str | None = Header(default=None),
    x_trace_id: str | None = Header(default=None),
) -> SupplierHealthResponse:
    _require_internal_token(x_internal_service_token)
    trace_id = (x_trace_id or _trace_id()).strip()
    started = time.perf_counter()

    suppliers: list[SupplierHealthItem] = []
    high_risk = 0
    for supplier in request.suppliers:
        risk_score = max(0.0, 1 - supplier.fill_rate) * 0.6 + supplier.spoilage_risk * 0.2 + min(supplier.lead_time_hours / 240.0, 1.0) * 0.2
        urgency = "watch"
        if risk_score >= 0.45 or supplier.reliability_band.lower() in {"fragile", "critical"}:
            urgency = "critical"
            high_risk += 1
        elif risk_score >= 0.25:
            urgency = "elevated"
        suppliers.append(
            SupplierHealthItem(
                supplier_id=supplier.supplier_id,
                supplier_name=supplier.supplier_name,
                lead_time_hours=round(supplier.lead_time_hours, 2),
                fill_rate=round(supplier.fill_rate, 4),
                spoilage_risk=round(supplier.spoilage_risk, 4),
                reliability_band=supplier.reliability_band,
                urgency=urgency,
                narrative=f"{supplier.supplier_name} is {urgency} with {supplier.fill_rate:.0%} fill rate and {supplier.lead_time_hours:.0f}h lead time.",
            )
        )

    resilience_band = "fragile" if high_risk > 0 else ("watch" if len(suppliers) >= 3 else "healthy")
    metrics = {
        "trace_id": trace_id,
        "request_duration_ms": round((time.perf_counter() - started) * 1000, 2),
        "supplier_count": len(suppliers),
        "payload_chars": len(request.model_dump_json()),
        "critical_suppliers": high_risk,
    }
    _trace("procurement.supplier_health_complete", metrics)
    response = SupplierHealthResponse(
        service="switchos-procurement-planner",
        generated_at=datetime.now(timezone.utc),
        city=request.city,
        resilience_band=resilience_band,
        suppliers=suppliers,
        summary=f"Evaluated {len(suppliers)} suppliers in {request.city}; {high_risk} require immediate mitigation.",
        metrics=metrics,
    )
    execution_store.record(
        "supplier_health",
        trace_id,
        {"city": request.city, "supplier_count": len(request.suppliers)},
        {"resilience_band": response.resilience_band, "supplier_count": len(response.suppliers)},
    )
    return response


class MaintenanceDemandPoint(BaseModel):
    point_id: str = Field(min_length=1, max_length=128)
    lat: float = Field(ge=-90.0, le=90.0)
    lon: float = Field(ge=-180.0, le=180.0)
    vehicles: int = Field(default=1, ge=1, le=10000)


class MaintenanceCandidate(BaseModel):
    provider_id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=255)
    lat: float = Field(ge=-90.0, le=90.0)
    lon: float = Field(ge=-180.0, le=180.0)
    vetted: bool = False
    capacity: int = Field(default=0, ge=0, le=100000)
    cost_minor: int = Field(default=0, ge=0)


class MaintenancePlanRequest(BaseModel):
    city: str = Field(min_length=2, max_length=128)
    max_travel_km: float = Field(default=10.0, gt=0, le=500)
    budget_minor: int | None = Field(default=None, ge=0)
    demand_points: list[MaintenanceDemandPoint] = Field(min_length=1, max_length=500)
    candidates: list[MaintenanceCandidate] = Field(min_length=1, max_length=200)


class MaintenancePlanResponse(BaseModel):
    service: str
    generated_at: datetime
    city: str
    max_travel_km: float
    selected: list[dict[str, Any]]
    coverage_pct: float
    uncovered: list[dict[str, Any]]
    total_vehicles: int
    covered_vehicles: int
    budget_minor: int | None
    budget_spent_minor: int
    summary: str
    metrics: dict[str, Any]


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "switchos-procurement-planner",
        "version": APP_VERSION,
        "modes": ["replenishment", "transfer", "supplier-health", "maintenance-network"],
    }


@app.post("/maintenance/plan", response_model=MaintenancePlanResponse)
def maintenance_plan(
    request: MaintenancePlanRequest,
    x_internal_service_token: str | None = Header(default=None),
    x_trace_id: str | None = Header(default=None),
) -> MaintenancePlanResponse:
    _require_internal_token(x_internal_service_token)
    if not isinstance(x_trace_id, str):  # Header default when invoked directly
        x_trace_id = None
    trace_id = (x_trace_id or _trace_id()).strip()
    started = time.perf_counter()

    try:
        plan = maintenance.plan_maintenance_network(
            [point.model_dump() for point in request.demand_points],
            [candidate.model_dump() for candidate in request.candidates],
            max_travel_km=request.max_travel_km,
            budget_minor=request.budget_minor,
        )
    except maintenance.MaintenancePlanError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    summary = (
        f"Planned maintenance coverage for {request.city}: "
        f"{plan['covered_vehicles']}/{plan['total_vehicles']} vehicles covered "
        f"({plan['coverage_pct']}%) by {len(plan['selected'])} providers; "
        f"{len(plan['uncovered'])} demand points remain uncovered."
    )
    metrics = {
        "trace_id": trace_id,
        "request_duration_ms": round((time.perf_counter() - started) * 1000, 2),
        "demand_point_count": len(request.demand_points),
        "candidate_count": len(request.candidates),
        "selected_count": len(plan["selected"]),
        "uncovered_count": len(plan["uncovered"]),
    }
    _trace("procurement.maintenance_plan_complete", metrics)
    response = MaintenancePlanResponse(
        service="switchos-procurement-planner",
        generated_at=datetime.now(timezone.utc),
        city=request.city,
        max_travel_km=request.max_travel_km,
        selected=plan["selected"],
        coverage_pct=plan["coverage_pct"],
        uncovered=plan["uncovered"],
        total_vehicles=plan["total_vehicles"],
        covered_vehicles=plan["covered_vehicles"],
        budget_minor=plan["budget_minor"],
        budget_spent_minor=plan["budget_spent_minor"],
        summary=summary,
        metrics=metrics,
    )
    execution_store.record(
        "maintenance_plan",
        trace_id,
        {"city": request.city, "demand_point_count": len(request.demand_points), "candidate_count": len(request.candidates)},
        {"coverage_pct": response.coverage_pct, "selected_count": len(response.selected)},
    )
    return response


def _require_internal_token(provided: str | None) -> None:
    if not INTERNAL_SERVICE_TOKEN:
        raise HTTPException(status_code=503, detail="internal authentication is not configured")
    if not isinstance(provided, str) or not provided or not hmac.compare_digest(provided, INTERNAL_SERVICE_TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized internal access")


def _trace(event: str, payload: dict[str, Any]) -> None:
    if TRACE_ENABLED:
        logger.info("procurement_event=%s payload=%s", event, payload)


def _trace_id() -> str:
    return f"proc-{uuid.uuid4()}"


if __name__ == "__main__":
    import uvicorn

    # UVICORN_WORKERS (default 2): workers > 1 requires the app as an import
    # string, so pass "main:app" — the service directory is on sys.path when
    # run as `python main.py` (see services/python/Dockerfile layout).
    uvicorn.run(
        "main:app",
        host=os.getenv("BIND_HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8116")),
        workers=int(os.getenv("UVICORN_WORKERS", "2")),
        timeout_keep_alive=30,
    )
