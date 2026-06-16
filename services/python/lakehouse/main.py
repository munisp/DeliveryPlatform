from __future__ import annotations

import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from prometheus_client import Counter, Histogram, generate_latest

from service import LakehouseService


app = FastAPI(
    title="SwitchOS Lakehouse Service",
    description="Lakehouse ingestion and lightweight query surface for marketplace analytics workloads.",
    version="1.0.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

request_count = Counter("lakehouse_requests_total", "Total lakehouse requests", ["endpoint"])
request_duration = Histogram("lakehouse_request_duration_seconds", "Lakehouse request duration", ["endpoint"])
service = LakehouseService()


@app.on_event("startup")
async def startup() -> None:
    await service.initialize()


@app.on_event("shutdown")
async def shutdown() -> None:
    await service.cleanup()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "healthy", "service": "lakehouse"}


@app.get("/metrics")
async def metrics() -> Response:
    return Response(content=generate_latest(), media_type="text/plain")


@app.get("/tables")
async def list_tables() -> dict[str, object]:
    request_count.labels("list_tables").inc()
    with request_duration.labels("list_tables").time():
        return {"tables": await service.list_tables()}


@app.post("/tables")
async def create_table(payload: dict[str, object]) -> dict[str, object]:
    request_count.labels("create_table").inc()
    with request_duration.labels("create_table").time():
        table_name = str(payload.get("table_name") or "")
        if not table_name:
            raise HTTPException(status_code=400, detail="table_name is required")
        return await service.create_table(
            table_name=table_name,
            partition_by=str(payload.get("partition_by", "date")),
            fmt=str(payload.get("format", "jsonl")),
        )


@app.get("/tables/{table_name}")
async def get_table_metadata(table_name: str) -> dict[str, object]:
    request_count.labels("get_table_metadata").inc()
    with request_duration.labels("get_table_metadata").time():
        metadata = await service.get_table_metadata(table_name)
        if not metadata:
            raise HTTPException(status_code=404, detail="Table not found")
        return metadata


@app.post("/ingest/{table_name}")
async def ingest(table_name: str, payload: dict[str, object]) -> dict[str, object]:
    request_count.labels("ingest").inc()
    with request_duration.labels("ingest").time():
        rows = payload.get("rows", [])
        if not isinstance(rows, list):
            raise HTTPException(status_code=400, detail="rows must be a list")
        normalized_rows = [row for row in rows if isinstance(row, dict)]
        return await service.ingest_data(table_name, normalized_rows)


@app.get("/query/{table_name}")
async def query(table_name: str, limit: int = 100) -> dict[str, object]:
    request_count.labels("query").inc()
    with request_duration.labels("query").time():
        return await service.query_data(table_name, limit=limit)


@app.get("/analytics/summary")
async def analytics_summary() -> dict[str, object]:
    request_count.labels("analytics_summary").inc()
    with request_duration.labels("analytics_summary").time():
        return await service.get_analytics_summary()


@app.get("/analytics/order-stats")
async def analytics_order_stats() -> dict[str, object]:
    request_count.labels("analytics_order_stats").inc()
    with request_duration.labels("analytics_order_stats").time():
        summary = await service.get_analytics_summary()
        return summary["order_stats"]


@app.get("/analytics/driver-stats")
async def analytics_driver_stats() -> dict[str, object]:
    request_count.labels("analytics_driver_stats").inc()
    with request_duration.labels("analytics_driver_stats").time():
        summary = await service.get_analytics_summary()
        return summary["driver_stats"]


@app.get("/analytics/marketplace-overview")
async def analytics_marketplace_overview() -> dict[str, object]:
    request_count.labels("analytics_marketplace_overview").inc()
    with request_duration.labels("analytics_marketplace_overview").time():
        summary = await service.get_analytics_summary()
        return summary["marketplace_overview"]


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8007")))
