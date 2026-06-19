from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from statistics import mean
from typing import Any

import psycopg
from loguru import logger


class LakehouseService:
    def __init__(self) -> None:
        self.database_url = os.getenv(
            "DATABASE_URL",
            "postgresql://ubuntu:ubuntu@127.0.0.1:5432/switchos?sslmode=disable",
        )
        self.schema_name = os.getenv("LAKEHOUSE_SCHEMA", "switchos_lakehouse")

    async def initialize(self) -> None:
        logger.info("Lakehouse service using PostgreSQL-backed schema {}", self.schema_name)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(f"CREATE SCHEMA IF NOT EXISTS {self.schema_name}")
                cur.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS {self.schema_name}.table_registry (
                        table_name TEXT PRIMARY KEY,
                        format TEXT NOT NULL,
                        partition_by TEXT NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                cur.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS {self.schema_name}.events (
                        id BIGSERIAL PRIMARY KEY,
                        table_name TEXT NOT NULL,
                        record_key TEXT,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        event_timestamp TIMESTAMPTZ NOT NULL,
                        partition_value TEXT NOT NULL,
                        payload JSONB NOT NULL
                    )
                    """
                )
                cur.execute(
                    f"CREATE INDEX IF NOT EXISTS idx_{self.schema_name}_events_table_time ON {self.schema_name}.events (table_name, event_timestamp DESC)"
                )
                cur.execute(
                    f"CREATE INDEX IF NOT EXISTS idx_{self.schema_name}_events_payload ON {self.schema_name}.events USING GIN (payload)"
                )
            conn.commit()
        for table_name in ("orders", "drivers", "payments", "marketplace_events"):
            await self.create_table(table_name, partition_by="date", fmt="jsonb")

    async def cleanup(self) -> None:
        logger.info("Lakehouse service cleanup complete")

    async def create_table(self, table_name: str, partition_by: str = "date", fmt: str = "jsonb") -> dict[str, Any]:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    INSERT INTO {self.schema_name}.table_registry (table_name, format, partition_by, created_at, updated_at)
                    VALUES (%s, %s, %s, NOW(), NOW())
                    ON CONFLICT (table_name) DO UPDATE
                    SET format = EXCLUDED.format,
                        partition_by = EXCLUDED.partition_by,
                        updated_at = NOW()
                    RETURNING table_name, format, partition_by, created_at, updated_at
                    """,
                    (table_name, fmt, partition_by),
                )
                row = cur.fetchone()
            conn.commit()
        return self._registry_row_to_dict(row) if row else {}

    async def ingest_data(self, table_name: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
        await self.create_table(table_name)
        if not rows:
            return {"success": True, "inserted": 0, "table_name": table_name}

        inserted = 0
        with self._connect() as conn:
            with conn.cursor() as cur:
                partition_by = self._get_partition_by(cur, table_name)
                for row in rows:
                    timestamp_raw = row.get("timestamp") or row.get("created_at") or datetime.now(timezone.utc).isoformat()
                    timestamp = self._parse_timestamp(timestamp_raw)
                    row.setdefault("timestamp", timestamp.isoformat())
                    row.setdefault("created_at", timestamp.isoformat())
                    row.setdefault("date", timestamp.date().isoformat())
                    partition_value = str(row.get(partition_by) or timestamp.date().isoformat())
                    record_key = self._derive_record_key(table_name, row)
                    cur.execute(
                        f"""
                        INSERT INTO {self.schema_name}.events (
                            table_name, record_key, created_at, event_timestamp, partition_value, payload
                        ) VALUES (%s, %s, NOW(), %s, %s, %s::jsonb)
                        """,
                        (table_name, record_key, timestamp, partition_value, json.dumps(row)),
                    )
                    inserted += 1
                cur.execute(
                    f"UPDATE {self.schema_name}.table_registry SET updated_at = NOW() WHERE table_name = %s",
                    (table_name,),
                )
            conn.commit()
        return {"success": True, "inserted": inserted, "table_name": table_name, "backend": "postgresql"}

    async def query_data(self, table_name: str, limit: int = 100) -> dict[str, Any]:
        rows = self._load_rows(table_name, limit=max(1, limit))
        row_count = self._count_rows(table_name)
        return {"table_name": table_name, "row_count": row_count, "rows": rows[:limit]}

    async def get_analytics_summary(self) -> dict[str, Any]:
        orders = self._load_rows("orders", limit=5000)
        drivers = self._load_rows("drivers", limit=2000)
        marketplace_events = self._load_rows("marketplace_events", limit=5000)

        order_stats = self._build_order_stats(orders)
        driver_stats = self._build_driver_stats(drivers)
        marketplace_overview = self._build_marketplace_overview(orders, drivers, marketplace_events)

        return {
            "source": "lakehouse",
            "backend": "postgresql",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "order_stats": order_stats,
            "driver_stats": driver_stats,
            "marketplace_overview": marketplace_overview,
        }

    async def list_tables(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT r.table_name, r.format, r.partition_by, r.created_at, r.updated_at,
                           COALESCE(c.row_count, 0) AS row_count
                    FROM {self.schema_name}.table_registry r
                    LEFT JOIN (
                        SELECT table_name, COUNT(*) AS row_count
                        FROM {self.schema_name}.events
                        GROUP BY table_name
                    ) c ON c.table_name = r.table_name
                    ORDER BY r.table_name ASC
                    """
                )
                rows = cur.fetchall()
        return [self._registry_listing_row_to_dict(row) for row in rows]

    async def get_table_metadata(self, table_name: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT r.table_name, r.format, r.partition_by, r.created_at, r.updated_at,
                           COALESCE(c.row_count, 0) AS row_count
                    FROM {self.schema_name}.table_registry r
                    LEFT JOIN (
                        SELECT table_name, COUNT(*) AS row_count
                        FROM {self.schema_name}.events
                        GROUP BY table_name
                    ) c ON c.table_name = r.table_name
                    WHERE r.table_name = %s
                    """,
                    (table_name,),
                )
                row = cur.fetchone()
        return self._registry_listing_row_to_dict(row) if row else None

    def _connect(self) -> psycopg.Connection:
        return psycopg.connect(self.database_url)

    def _get_partition_by(self, cur: psycopg.Cursor, table_name: str) -> str:
        cur.execute(
            f"SELECT partition_by FROM {self.schema_name}.table_registry WHERE table_name = %s",
            (table_name,),
        )
        row = cur.fetchone()
        if not row:
            return "date"
        return str(row[0] or "date")

    def _load_rows(self, table_name: str, limit: int = 100) -> list[dict[str, Any]]:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT payload
                    FROM {self.schema_name}.events
                    WHERE table_name = %s
                    ORDER BY event_timestamp DESC, id DESC
                    LIMIT %s
                    """,
                    (table_name, limit),
                )
                rows = cur.fetchall()
        return [row[0] for row in rows]

    def _count_rows(self, table_name: str) -> int:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT COUNT(*) FROM {self.schema_name}.events WHERE table_name = %s",
                    (table_name,),
                )
                row = cur.fetchone()
        return int(row[0]) if row else 0

    def _derive_record_key(self, table_name: str, row: dict[str, Any]) -> str | None:
        for key in (
            "id",
            "order_id",
            "driver_id",
            "payment_id",
            "transaction_id",
            "event_id",
            "quote_id",
        ):
            if key in row and row[key] not in (None, ""):
                return f"{table_name}:{row[key]}"
        return None

    def _registry_row_to_dict(self, row: Any) -> dict[str, Any]:
        return {
            "table_name": row[0],
            "format": row[1],
            "partition_by": row[2],
            "created_at": row[3].isoformat() if row[3] else None,
            "updated_at": row[4].isoformat() if row[4] else None,
        }

    def _registry_listing_row_to_dict(self, row: Any) -> dict[str, Any]:
        return {
            "table_name": row[0],
            "format": row[1],
            "partition_by": row[2],
            "created_at": row[3].isoformat() if row[3] else None,
            "updated_at": row[4].isoformat() if row[4] else None,
            "row_count": int(row[5]),
        }

    def _parse_timestamp(self, raw: Any) -> datetime:
        if isinstance(raw, datetime):
            return raw.astimezone(timezone.utc) if raw.tzinfo else raw.replace(tzinfo=timezone.utc)
        if raw is None:
            return datetime.now(timezone.utc)
        try:
            return datetime.fromisoformat(str(raw).replace("Z", "+00:00")).astimezone(timezone.utc)
        except Exception:
            return datetime.now(timezone.utc)

    def _to_float(self, raw: Any) -> float:
        try:
            if raw is None or raw == "":
                return 0.0
            return float(raw)
        except Exception:
            return 0.0

    def _build_order_stats(self, orders: list[dict[str, Any]]) -> dict[str, Any]:
        delivered = [order for order in orders if str(order.get("status", "")).lower() == "delivered"]
        cancelled = [order for order in orders if str(order.get("status", "")).lower() == "cancelled"]
        revenue = sum(self._to_float(order.get("total_amount")) for order in delivered)
        return {
            "total": len(orders),
            "completed": len(delivered),
            "cancelled": len(cancelled),
            "revenue": f"{revenue:.2f}",
        }

    def _build_driver_stats(self, drivers: list[dict[str, Any]]) -> dict[str, Any]:
        normalized_statuses = [str(driver.get("status", "offline")).lower() for driver in drivers]
        return {
            "total": len(drivers),
            "online": sum(1 for status in normalized_statuses if status in {"online", "available"}),
            "busy": sum(1 for status in normalized_statuses if status == "busy"),
            "offline": sum(1 for status in normalized_statuses if status not in {"online", "available", "busy"}),
        }

    def _build_marketplace_overview(
        self,
        orders: list[dict[str, Any]],
        drivers: list[dict[str, Any]],
        marketplace_events: list[dict[str, Any]],
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        open_statuses = {"pending", "confirmed", "assigned", "in_progress", "picked_up", "in_transit"}
        waiting_statuses = {"pending"}

        open_orders = [order for order in orders if str(order.get("status", "")).lower() in open_statuses]
        waiting_orders = [order for order in orders if str(order.get("status", "")).lower() in waiting_statuses]
        waiting_minutes = [
            max(0.0, (now - self._parse_timestamp(order.get("created_at") or order.get("timestamp"))).total_seconds() / 60.0)
            for order in waiting_orders
        ]

        available_driver_rows = [
            driver for driver in drivers if str(driver.get("status", "")).lower() in {"online", "available"}
        ]
        busy_driver_rows = [driver for driver in drivers if str(driver.get("status", "")).lower() == "busy"]

        zone_groups: dict[str, dict[str, Any]] = {}

        def bucket_for(zone_key: str) -> dict[str, Any]:
            if zone_key not in zone_groups:
                zone_groups[zone_key] = {
                    "zone_key": zone_key,
                    "open_orders": 0,
                    "waiting_orders": 0,
                    "avg_wait_samples": [],
                    "available_drivers": 0,
                    "busy_drivers": 0,
                }
            return zone_groups[zone_key]

        for order in orders:
            zone_key = str(order.get("vertical_id") or order.get("zone_key") or 0)
            bucket = bucket_for(zone_key)
            status = str(order.get("status", "")).lower()
            if status in open_statuses:
                bucket["open_orders"] += 1
            if status in waiting_statuses:
                bucket["waiting_orders"] += 1
                bucket["avg_wait_samples"].append(
                    max(0.0, (now - self._parse_timestamp(order.get("created_at") or order.get("timestamp"))).total_seconds() / 60.0)
                )

        for driver in drivers:
            zone_key = str(driver.get("primary_vertical_id") or driver.get("vertical_id") or 0)
            bucket = bucket_for(zone_key)
            status = str(driver.get("status", "")).lower()
            if status in {"online", "available"}:
                bucket["available_drivers"] += 1
            elif status == "busy":
                bucket["busy_drivers"] += 1

        hotspots: list[dict[str, Any]] = []
        for zone_key, bucket in zone_groups.items():
            avg_wait_minutes = mean(bucket["avg_wait_samples"]) if bucket["avg_wait_samples"] else 0.0
            available_drivers = int(bucket["available_drivers"])
            waiting = int(bucket["waiting_orders"])
            pressure_ratio = waiting / available_drivers if available_drivers else float(waiting)
            if pressure_ratio >= 3 or avg_wait_minutes >= 20:
                pressure_band = "critical"
                recommended_action = "Rebalance drivers immediately and tighten dispatch radius."
            elif pressure_ratio >= 1.5 or avg_wait_minutes >= 10:
                pressure_band = "elevated"
                recommended_action = "Offer demand incentives and prioritize the next available supply."
            elif waiting == 0 and available_drivers > 0:
                pressure_band = "surplus"
                recommended_action = "Shift excess supply to adjacent zones or promotional windows."
            else:
                pressure_band = "balanced"
                recommended_action = "Maintain normal dispatch policy and continue monitoring."

            hotspots.append(
                {
                    "zone_key": zone_key,
                    "open_orders": int(bucket["open_orders"]),
                    "waiting_orders": waiting,
                    "avg_wait_minutes": round(avg_wait_minutes, 2),
                    "available_drivers": available_drivers,
                    "busy_drivers": int(bucket["busy_drivers"]),
                    "pressure_ratio": round(pressure_ratio, 2),
                    "pressure_band": pressure_band,
                    "recommended_action": recommended_action,
                }
            )

        hotspots.sort(key=lambda row: (row["pressure_ratio"], row["waiting_orders"], row["open_orders"]), reverse=True)
        recent_events = marketplace_events[:10]

        return {
            "open_orders": len(open_orders),
            "waiting_orders": len(waiting_orders),
            "avg_wait_minutes": round(mean(waiting_minutes), 2) if waiting_minutes else 0.0,
            "available_drivers": len(available_driver_rows),
            "busy_drivers": len(busy_driver_rows),
            "hotspots": hotspots[:8],
            "recent_events": recent_events,
        }
