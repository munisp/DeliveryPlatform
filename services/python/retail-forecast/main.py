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

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from durable_run_store import DurableRunStore

INTERNAL_SERVICE_TOKEN = os.getenv("INTERNAL_SERVICE_TOKEN", "").strip()
logger = logging.getLogger("switchos.retail_forecast")
APP_VERSION = "2026-07-09-logistics-resilience-wave"
TRACE_ENABLED = os.getenv("LOCAL_COMMERCE_ENABLE_TRACING", "true").strip().lower() == "true"

app = FastAPI(title="switchos-retail-forecast", version=APP_VERSION)
execution_store = DurableRunStore("retail-forecast")


@app.on_event("startup")
async def startup() -> None:
    execution_store.initialize()


class DemandPoint(BaseModel):
    timestamp: datetime
    units: float = Field(ge=0)


class ForecastSku(BaseModel):
    sku: str = Field(min_length=1, max_length=128)
    label: str | None = Field(default=None, max_length=255)
    category: str | None = Field(default=None, max_length=128)
    on_hand_units: float = Field(default=0, ge=0)
    reserved_units: float = Field(default=0, ge=0)
    inbound_units: float = Field(default=0, ge=0)
    lead_time_hours: float = Field(default=8, ge=1, le=240)
    shelf_life_hours: float | None = Field(default=None, ge=1)
    service_level: float = Field(default=0.95, ge=0.5, le=0.999)
    demand_history: list[DemandPoint] = Field(default_factory=list)
    event_multiplier: float | None = Field(default=None, ge=0.5, le=3)
    weather_multiplier: float | None = Field(default=None, ge=0.5, le=2)
    substitution_group: str | None = Field(default=None, max_length=128)
    cold_chain_required: bool = False


class ForecastRequest(BaseModel):
    merchant_id: int | None = Field(default=None, ge=1)
    merchant_name: str | None = Field(default=None, max_length=255)
    city: str | None = Field(default=None, max_length=128)
    planning_horizon_hours: int = Field(default=24, ge=4, le=168)
    skus: list[ForecastSku] = Field(default_factory=list)


class BatchForecastRequest(BaseModel):
    requests: list[ForecastRequest] = Field(default_factory=list, min_length=1, max_length=100)


class NetworkHealthNode(BaseModel):
    warehouse_id: int = Field(ge=1)
    label: str = Field(min_length=1, max_length=255)
    zone_key: str | None = Field(default=None, max_length=128)
    cold_chain_ready: bool = False
    stock_accuracy: float = Field(default=0.92, ge=0, le=1)
    on_hand_units: float = Field(default=0, ge=0)
    reserved_units: float = Field(default=0, ge=0)
    inbound_units: float = Field(default=0, ge=0)
    hourly_demand: float = Field(default=0.25, ge=0)
    lead_time_hours: float = Field(default=8, ge=1, le=240)
    freshness_hours: float | None = Field(default=None, ge=1)
    critical_skus: int = Field(default=0, ge=0)


class NetworkHealthRequest(BaseModel):
    city: str | None = Field(default=None, max_length=128)
    planning_horizon_hours: int = Field(default=24, ge=4, le=168)
    nodes: list[NetworkHealthNode] = Field(default_factory=list, min_length=1, max_length=100)


class ForecastSkuResponse(BaseModel):
    sku: str
    label: str | None
    forecast_units: float
    forecast_velocity_per_hour: float
    reorder_point_units: float
    recommended_restock_units: float
    stock_cover_hours: float
    stockout_risk: str
    freshness_watchout: str | None
    narrative: str


class ForecastMetrics(BaseModel):
    trace_id: str
    request_duration_ms: float
    sku_count: int
    payload_chars: int
    demand_points: int
    merchant_name: str | None = None
    batch_size: int | None = None


class ForecastResponse(BaseModel):
    service: str
    generated_at: datetime
    merchant_name: str | None
    city: str | None
    planning_horizon_hours: int
    recommendations: list[ForecastSkuResponse]
    summary: str
    metrics: ForecastMetrics


class BatchForecastResponse(BaseModel):
    service: str
    generated_at: datetime
    batch_size: int
    summaries: list[str]
    forecasts: list[ForecastResponse]
    metrics: ForecastMetrics


class NetworkNodeHealthResponse(BaseModel):
    warehouse_id: int
    label: str
    zone_key: str | None
    stock_cover_hours: float
    recommended_restock_units: float
    risk_band: str
    cold_chain_ready: bool
    stock_accuracy: float
    critical_skus: int
    narrative: str


class NetworkHealthMetrics(BaseModel):
    trace_id: str
    request_duration_ms: float
    node_count: int
    payload_chars: int
    critical_nodes: int
    constrained_nodes: int


class NetworkHealthResponse(BaseModel):
    service: str
    generated_at: datetime
    city: str | None
    planning_horizon_hours: int
    resilience_band: str
    constrained_nodes: int
    critical_nodes: int
    nodes: list[NetworkNodeHealthResponse]
    summary: str
    metrics: NetworkHealthMetrics


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str
    ready: bool
    forecast_modes: list[str]


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    try:
        execution_store.check()
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return HealthResponse(
        status="healthy",
        service="switchos-retail-forecast",
        version=APP_VERSION,
        ready=True,
        forecast_modes=["ewma", "lead-time-buffer", "freshness-aware", "batch", "network-resilience"],
    )


@app.post("/forecast", response_model=ForecastResponse)
def forecast(request: ForecastRequest, x_internal_service_token: str | None = Header(default=None), x_trace_id: str | None = Header(default=None)) -> ForecastResponse:
    _require_internal_token(x_internal_service_token)
    trace_id = (x_trace_id or _trace_id()).strip()
    started = time.perf_counter()
    response = _forecast_request(request, trace_id=trace_id)
    response.metrics.request_duration_ms = round((time.perf_counter() - started) * 1000, 2)
    _trace("forecast.complete", response.metrics.model_dump())
    execution_store.record(
        "forecast",
        trace_id,
        {"merchant_id": request.merchant_id, "city": request.city, "planning_horizon_hours": request.planning_horizon_hours, "sku_count": len(request.skus)},
        {"recommendation_count": len(response.recommendations), "high_risk_count": sum(1 for item in response.recommendations if item.stockout_risk in {"critical", "elevated"})},
    )
    return response


@app.post("/forecast/batch", response_model=BatchForecastResponse)
def forecast_batch(request: BatchForecastRequest, x_internal_service_token: str | None = Header(default=None), x_trace_id: str | None = Header(default=None)) -> BatchForecastResponse:
    _require_internal_token(x_internal_service_token)
    trace_id = (x_trace_id or _trace_id()).strip()
    started = time.perf_counter()
    forecasts = [_forecast_request(item, trace_id=f"{trace_id}-{index + 1}") for index, item in enumerate(request.requests)]
    payload_chars = sum(len(item.model_dump_json()) for item in request.requests)
    demand_points = sum(len(sku.demand_history) for item in request.requests for sku in item.skus)
    response = BatchForecastResponse(
        service="switchos-retail-forecast",
        generated_at=datetime.now(timezone.utc),
        batch_size=len(request.requests),
        summaries=[item.summary for item in forecasts],
        forecasts=forecasts,
        metrics=ForecastMetrics(
            trace_id=trace_id,
            request_duration_ms=round((time.perf_counter() - started) * 1000, 2),
            sku_count=sum(len(item.skus) for item in request.requests),
            payload_chars=payload_chars,
            demand_points=demand_points,
            batch_size=len(request.requests),
        ),
    )
    _trace("forecast.batch_complete", response.metrics.model_dump())
    execution_store.record(
        "forecast_batch",
        trace_id,
        {"batch_size": len(request.requests), "sku_count": response.metrics.sku_count},
        {"forecast_count": len(response.forecasts), "demand_points": response.metrics.demand_points},
    )
    return response


@app.post("/restock-plan", response_model=ForecastResponse)
def restock_plan(request: ForecastRequest, x_internal_service_token: str | None = Header(default=None), x_trace_id: str | None = Header(default=None)) -> ForecastResponse:
    return forecast(request, x_internal_service_token, x_trace_id)


@app.post("/network-health", response_model=NetworkHealthResponse)
def network_health(request: NetworkHealthRequest, x_internal_service_token: str | None = Header(default=None), x_trace_id: str | None = Header(default=None)) -> NetworkHealthResponse:
    _require_internal_token(x_internal_service_token)
    trace_id = (x_trace_id or _trace_id()).strip()
    started = time.perf_counter()

    responses = [_score_network_node(node, request.planning_horizon_hours) for node in request.nodes]
    critical_nodes = sum(1 for node in responses if node.risk_band == "critical")
    constrained_nodes = sum(1 for node in responses if node.risk_band in {"critical", "constrained"})
    if critical_nodes > 0:
        resilience_band = "fragile"
    elif constrained_nodes >= max(2, len(responses) // 2):
        resilience_band = "watch"
    else:
        resilience_band = "healthy"

    summary = (
        f"Evaluated {len(responses)} logistics nodes over {request.planning_horizon_hours}h; "
        f"{critical_nodes} are critical and {constrained_nodes} require restock or reroute attention."
    )
    response = NetworkHealthResponse(
        service="switchos-retail-forecast",
        generated_at=datetime.now(timezone.utc),
        city=request.city,
        planning_horizon_hours=request.planning_horizon_hours,
        resilience_band=resilience_band,
        constrained_nodes=constrained_nodes,
        critical_nodes=critical_nodes,
        nodes=responses,
        summary=summary,
        metrics=NetworkHealthMetrics(
            trace_id=trace_id,
            request_duration_ms=round((time.perf_counter() - started) * 1000, 2),
            node_count=len(request.nodes),
            payload_chars=len(request.model_dump_json()),
            critical_nodes=critical_nodes,
            constrained_nodes=constrained_nodes,
        ),
    )
    _trace("network_health.complete", response.metrics.model_dump())
    execution_store.record(
        "network_health",
        trace_id,
        {"city": request.city, "planning_horizon_hours": request.planning_horizon_hours, "node_count": len(request.nodes)},
        {"resilience_band": response.resilience_band, "critical_nodes": response.critical_nodes, "constrained_nodes": response.constrained_nodes},
    )
    return response


def _require_internal_token(provided: str | None) -> None:
    if not INTERNAL_SERVICE_TOKEN:
        raise HTTPException(status_code=503, detail="internal authentication is not configured")
    if not provided or not hmac.compare_digest(provided, INTERNAL_SERVICE_TOKEN):
        raise HTTPException(status_code=401, detail="invalid internal service token")


def _forecast_request(request: ForecastRequest, trace_id: str) -> ForecastResponse:
    if not request.skus:
        raise HTTPException(status_code=400, detail="at least one sku is required")

    recommendations = [_forecast_sku(sku, request.planning_horizon_hours) for sku in request.skus]
    high_risk = [item for item in recommendations if item.stockout_risk in {"critical", "elevated"}]
    summary = (
        f"Forecasted {len(recommendations)} SKUs over {request.planning_horizon_hours}h; "
        f"{len(high_risk)} require urgent inventory or substitution attention."
    )
    return ForecastResponse(
        service="switchos-retail-forecast",
        generated_at=datetime.now(timezone.utc),
        merchant_name=request.merchant_name,
        city=request.city,
        planning_horizon_hours=request.planning_horizon_hours,
        recommendations=recommendations,
        summary=summary,
        metrics=ForecastMetrics(
            trace_id=trace_id,
            request_duration_ms=0,
            sku_count=len(request.skus),
            payload_chars=len(request.model_dump_json()),
            demand_points=sum(len(sku.demand_history) for sku in request.skus),
            merchant_name=request.merchant_name,
        ),
    )


def _forecast_sku(sku: ForecastSku, planning_horizon_hours: int) -> ForecastSkuResponse:
    history = sorted(sku.demand_history, key=lambda item: item.timestamp)
    if not history:
        baseline_velocity = max(0.25, (sku.on_hand_units + sku.inbound_units) / max(planning_horizon_hours * 2, 1))
    else:
        trailing = history[-12:]
        ewma = 0.0
        alpha = 0.42
        for point in trailing:
            ewma = alpha * point.units + (1 - alpha) * ewma
        observed_hours = max((trailing[-1].timestamp - trailing[0].timestamp).total_seconds() / 3600, 1)
        baseline_velocity = max(ewma, sum(point.units for point in trailing) / observed_hours / max(len(trailing) / 4, 1))

    event_multiplier = sku.event_multiplier or 1.0
    weather_multiplier = sku.weather_multiplier or 1.0
    adjusted_velocity = baseline_velocity * event_multiplier * weather_multiplier
    forecast_units = adjusted_velocity * planning_horizon_hours

    net_available = max(sku.on_hand_units - sku.reserved_units + sku.inbound_units, 0)
    service_buffer = _service_buffer_multiplier(sku.service_level)
    reorder_point_units = adjusted_velocity * sku.lead_time_hours * service_buffer
    recommended_restock_units = max(reorder_point_units + forecast_units - net_available, 0)
    stock_cover_hours = net_available / adjusted_velocity if adjusted_velocity > 0 else float("inf")

    if stock_cover_hours < min(sku.lead_time_hours, 6):
        stockout_risk = "critical"
    elif stock_cover_hours < sku.lead_time_hours * 1.5:
        stockout_risk = "elevated"
    elif stock_cover_hours < planning_horizon_hours:
        stockout_risk = "watch"
    else:
        stockout_risk = "healthy"

    freshness_watchout = None
    if sku.shelf_life_hours is not None and sku.shelf_life_hours > 0:
        if stock_cover_hours > sku.shelf_life_hours:
            freshness_watchout = "Current stock cover exceeds shelf-life window; route through discounting or substitution-first merchandising."
        elif sku.shelf_life_hours - stock_cover_hours < 8:
            freshness_watchout = "Shelf-life margin is tightening; prefer this SKU in recommendation and batching logic before the next replenishment cycle."

    narrative_parts = [
        f"Projected demand is {forecast_units:.1f} units over {planning_horizon_hours}h at {adjusted_velocity:.2f} units/hour.",
        f"Net available stock covers roughly {stock_cover_hours:.1f} hours.",
    ]
    if recommended_restock_units > 0:
        narrative_parts.append(f"Recommended restock is {recommended_restock_units:.1f} units to protect a {int(sku.service_level * 100)}% service level.")
    else:
        narrative_parts.append("Current stock and inbound inventory are sufficient for the modeled horizon.")
    if sku.cold_chain_required:
        narrative_parts.append("Cold-chain handling is required, so keep warehouse allocation biased toward refrigerated nodes.")
    if freshness_watchout:
        narrative_parts.append(freshness_watchout)

    return ForecastSkuResponse(
        sku=sku.sku,
        label=sku.label,
        forecast_units=round(forecast_units, 2),
        forecast_velocity_per_hour=round(adjusted_velocity, 3),
        reorder_point_units=round(reorder_point_units, 2),
        recommended_restock_units=round(recommended_restock_units, 2),
        stock_cover_hours=round(stock_cover_hours if math.isfinite(stock_cover_hours) else 9999, 2),
        stockout_risk=stockout_risk,
        freshness_watchout=freshness_watchout,
        narrative=" ".join(narrative_parts),
    )


def _score_network_node(node: NetworkHealthNode, planning_horizon_hours: int) -> NetworkNodeHealthResponse:
    effective_velocity = max(node.hourly_demand, 0.05)
    net_available = max(node.on_hand_units - node.reserved_units + node.inbound_units, 0)
    stock_cover_hours = net_available / effective_velocity if effective_velocity > 0 else float("inf")
    reorder_point_units = effective_velocity * node.lead_time_hours * 1.18
    horizon_need_units = effective_velocity * planning_horizon_hours
    recommended_restock_units = max(reorder_point_units + horizon_need_units - net_available, 0)

    if stock_cover_hours < min(node.lead_time_hours, 6) or node.stock_accuracy < 0.75:
        risk_band = "critical"
    elif stock_cover_hours < planning_horizon_hours / 2 or node.critical_skus >= 3:
        risk_band = "constrained"
    elif stock_cover_hours < planning_horizon_hours or node.stock_accuracy < 0.9:
        risk_band = "watch"
    else:
        risk_band = "healthy"

    narrative = (
        f"{node.label} covers roughly {stock_cover_hours:.1f} hours at {effective_velocity:.2f} units/hour, "
        f"with stock accuracy at {node.stock_accuracy:.0%}."
    )
    if recommended_restock_units > 0:
        narrative += f" Recommended restock is {recommended_restock_units:.1f} units to stabilize the next replenishment cycle."
    if not node.cold_chain_ready:
        narrative += " Cold-chain unavailable, so regulated or chilled baskets should be rerouted away from this node."

    return NetworkNodeHealthResponse(
        warehouse_id=node.warehouse_id,
        label=node.label,
        zone_key=node.zone_key,
        stock_cover_hours=round(stock_cover_hours if math.isfinite(stock_cover_hours) else 9999, 2),
        recommended_restock_units=round(recommended_restock_units, 2),
        risk_band=risk_band,
        cold_chain_ready=node.cold_chain_ready,
        stock_accuracy=round(node.stock_accuracy, 3),
        critical_skus=node.critical_skus,
        narrative=narrative,
    )


def _service_buffer_multiplier(service_level: float) -> float:
    if service_level >= 0.99:
        return 1.45
    if service_level >= 0.97:
        return 1.3
    if service_level >= 0.95:
        return 1.18
    if service_level >= 0.9:
        return 1.08
    return 1.0


def _trace(event: str, payload: dict[str, Any]) -> None:
    if TRACE_ENABLED:
        logger.info("retail_forecast_event=%s payload=%s", event, payload)


def _trace_id() -> str:
    return f"rf-{uuid.uuid4()}"
