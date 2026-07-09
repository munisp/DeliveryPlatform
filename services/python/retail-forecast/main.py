from __future__ import annotations

import math
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

INTERNAL_SERVICE_TOKEN = os.getenv("INTERNAL_SERVICE_TOKEN", "switchos-internal-dev-token-change-before-production")
APP_VERSION = "2026-07-09-meituan-gap-wave"

app = FastAPI(title="switchos-retail-forecast", version=APP_VERSION)


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


class ForecastResponse(BaseModel):
    service: str
    generated_at: datetime
    merchant_name: str | None
    city: str | None
    planning_horizon_hours: int
    recommendations: list[ForecastSkuResponse]
    summary: str


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str
    ready: bool
    forecast_modes: list[str]


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="healthy",
        service="switchos-retail-forecast",
        version=APP_VERSION,
        ready=True,
        forecast_modes=["ewma", "lead-time-buffer", "freshness-aware"],
    )


@app.post("/forecast", response_model=ForecastResponse)
def forecast(request: ForecastRequest, x_internal_service_token: str | None = Header(default=None)) -> ForecastResponse:
    _require_internal_token(x_internal_service_token)
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
    )


@app.post("/restock-plan", response_model=ForecastResponse)
def restock_plan(request: ForecastRequest, x_internal_service_token: str | None = Header(default=None)) -> ForecastResponse:
    return forecast(request, x_internal_service_token)


def _require_internal_token(provided: str | None) -> None:
    if not INTERNAL_SERVICE_TOKEN:
        return
    if provided != INTERNAL_SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="invalid internal service token")


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
