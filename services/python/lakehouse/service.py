from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean
from typing import Any

from loguru import logger


class LakehouseService:
    def __init__(self) -> None:
        self.base_path = Path(os.getenv("LAKEHOUSE_PATH", "/tmp/switchos-lakehouse"))
        self.table_paths: dict[str, Path] = {}
        self.metadata: dict[str, dict[str, Any]] = {}
        self.base_path.mkdir(parents=True, exist_ok=True)

    async def initialize(self) -> None:
        logger.info("Lakehouse service using base path {}", self.base_path)
        for table_name in ("orders", "drivers", "payments", "marketplace_events"):
            await self.create_table(table_name, partition_by="date", fmt="jsonl")

    async def cleanup(self) -> None:
        logger.info("Lakehouse service cleanup complete")

    async def create_table(self, table_name: str, partition_by: str = "date", fmt: str = "jsonl") -> dict[str, Any]:
        table_path = self.base_path / table_name
        table_path.mkdir(parents=True, exist_ok=True)
        self.table_paths[table_name] = table_path
        self.metadata.setdefault(
            table_name,
            {
                "table_name": table_name,
                "format": fmt,
                "partition_by": partition_by,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "row_count": 0,
            },
        )
        return self.metadata[table_name]

    async def ingest_data(self, table_name: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
        if table_name not in self.table_paths:
            await self.create_table(table_name)

        if not rows:
            return {"success": True, "inserted": 0, "table_name": table_name}

        partition_key = self.metadata[table_name].get("partition_by", "date")
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            timestamp_raw = row.get("timestamp") or row.get("created_at") or datetime.now(timezone.utc).isoformat()
            timestamp = self._parse_timestamp(timestamp_raw)
            row.setdefault("timestamp", timestamp.isoformat())
            row.setdefault("created_at", timestamp.isoformat())
            row.setdefault("date", timestamp.date().isoformat())
            partition_value = row.get(partition_key) or timestamp.date().isoformat()
            grouped[str(partition_value)].append(row)

        inserted = 0
        for partition_value, partition_rows in grouped.items():
            partition_dir = self.table_paths[table_name] / f"{partition_key}={partition_value}"
            partition_dir.mkdir(parents=True, exist_ok=True)
            output_file = partition_dir / "events.jsonl"
            with output_file.open("a", encoding="utf-8") as handle:
                for row in partition_rows:
                    handle.write(json.dumps(row, ensure_ascii=False) + "\n")
                    inserted += 1

        self.metadata[table_name]["row_count"] = int(self.metadata[table_name].get("row_count", 0)) + inserted
        self.metadata[table_name]["updated_at"] = datetime.now(timezone.utc).isoformat()
        return {
            "success": True,
            "inserted": inserted,
            "table_name": table_name,
            "path": str(self.table_paths[table_name]),
        }

    async def query_data(self, table_name: str, limit: int = 100) -> dict[str, Any]:
        if table_name not in self.table_paths:
            return {"table_name": table_name, "rows": [], "row_count": 0}

        rows = self._load_rows(table_name, limit=limit)
        return {
            "table_name": table_name,
            "row_count": int(self.metadata.get(table_name, {}).get("row_count", len(rows))),
            "rows": rows[:limit],
        }

    async def get_analytics_summary(self) -> dict[str, Any]:
        orders = self._load_rows("orders", limit=5000)
        drivers = self._load_rows("drivers", limit=2000)
        marketplace_events = self._load_rows("marketplace_events", limit=5000)

        order_stats = self._build_order_stats(orders)
        driver_stats = self._build_driver_stats(drivers)
        marketplace_overview = self._build_marketplace_overview(orders, drivers, marketplace_events)

        return {
            "source": "lakehouse",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "order_stats": order_stats,
            "driver_stats": driver_stats,
            "marketplace_overview": marketplace_overview,
        }

    async def list_tables(self) -> list[dict[str, Any]]:
        return [self.metadata[name] for name in sorted(self.metadata.keys())]

    async def get_table_metadata(self, table_name: str) -> dict[str, Any] | None:
        return self.metadata.get(table_name)

    def _load_rows(self, table_name: str, limit: int = 100) -> list[dict[str, Any]]:
        if table_name not in self.table_paths:
            return []

        rows: list[dict[str, Any]] = []
        files = sorted(self.table_paths[table_name].rglob("*.jsonl"), reverse=True)
        for jsonl_file in files:
            with jsonl_file.open("r", encoding="utf-8") as handle:
                for line in handle:
                    try:
                        rows.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
                    if len(rows) >= limit:
                        return rows[:limit]
        return rows[:limit]

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
        open_statuses = {"pending", "confirmed", "assigned", "in_progress"}
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

        zone_groups: dict[str, dict[str, Any]] = defaultdict(
            lambda: {
                "zone_key": "0",
                "open_orders": 0,
                "waiting_orders": 0,
                "avg_wait_samples": [],
                "available_drivers": 0,
                "busy_drivers": 0,
            }
        )

        for order in orders:
            zone_key = str(order.get("vertical_id") or order.get("zone_key") or 0)
            bucket = zone_groups[zone_key]
            bucket["zone_key"] = zone_key
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
            bucket = zone_groups[zone_key]
            bucket["zone_key"] = zone_key
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
        assignment_events_7d = 0
        seven_days_ago = now.timestamp() - (7 * 24 * 60 * 60)
        for event in marketplace_events:
            event_type = str(event.get("event_type") or event.get("type") or "").lower()
            event_timestamp = self._parse_timestamp(event.get("timestamp") or event.get("created_at"))
            if event_timestamp.timestamp() >= seven_days_ago and event_type in {"assignment", "driver_assigned", "orders.driver_assigned"}:
                assignment_events_7d += 1

        if assignment_events_7d == 0:
            assignment_events_7d = sum(1 for order in orders if order.get("driver_id") is not None)

        return {
            "queue": {
                "pending_orders": len(waiting_orders),
                "avg_queue_minutes": round(mean(waiting_minutes), 2) if waiting_minutes else 0.0,
            },
            "drivers": {
                "available_drivers": len(available_driver_rows),
                "busy_drivers": len(busy_driver_rows),
            },
            "activity_signals": {
                "assignment_events_7d": assignment_events_7d,
            },
            "hotspots": hotspots[:8],
        }
