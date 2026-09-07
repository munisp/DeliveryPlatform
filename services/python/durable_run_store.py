from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any, Mapping

import psycopg


class DurableRunStore:
    """Persists non-sensitive service execution metadata in PostgreSQL."""

    def __init__(self, service_name: str, database_url: str | None = None) -> None:
        self.service_name = service_name
        self.database_url = (database_url or os.getenv("DATABASE_URL", "")).strip()

    def initialize(self) -> None:
        if not self.database_url:
            raise RuntimeError("DATABASE_URL is required for durable service execution records")
        with psycopg.connect(self.database_url, autocommit=True) as connection:
            connection.execute("SELECT pg_advisory_lock(hashtext('switchos.service_execution_records.schema'))")
            try:
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS service_execution_records (
                        id BIGSERIAL PRIMARY KEY,
                        service_name TEXT NOT NULL,
                        operation TEXT NOT NULL,
                        trace_id TEXT NOT NULL,
                        request_metadata JSONB NOT NULL,
                        response_metadata JSONB NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                connection.execute(
                    """
                    CREATE INDEX IF NOT EXISTS service_execution_records_service_trace_idx
                    ON service_execution_records (service_name, trace_id, created_at DESC)
                    """
                )
            finally:
                connection.execute("SELECT pg_advisory_unlock(hashtext('switchos.service_execution_records.schema'))")

    def check(self) -> None:
        if not self.database_url:
            raise RuntimeError("DATABASE_URL is required for durable service execution records")
        with psycopg.connect(self.database_url, autocommit=True) as connection:
            connection.execute("SELECT 1")

    def record(
        self,
        operation: str,
        trace_id: str,
        request_metadata: Mapping[str, Any],
        response_metadata: Mapping[str, Any],
    ) -> None:
        if not self.database_url:
            raise RuntimeError("DATABASE_URL is required for durable service execution records")
        with psycopg.connect(self.database_url, autocommit=True) as connection:
            connection.execute(
                """
                INSERT INTO service_execution_records
                    (service_name, operation, trace_id, request_metadata, response_metadata, created_at)
                VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s)
                """,
                (
                    self.service_name,
                    operation,
                    trace_id,
                    json.dumps(dict(request_metadata), default=_json_default, separators=(",", ":")),
                    json.dumps(dict(response_metadata), default=_json_default, separators=(",", ":")),
                    datetime.now(timezone.utc),
                ),
            )


def _json_default(value: Any) -> str:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    return str(value)
