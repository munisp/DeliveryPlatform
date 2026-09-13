#!/usr/bin/env python3
"""Validate DeliveryPlatform's versioned Iceberg and Delta Lakehouse SQL contracts.

This is a deliberately narrow, dependency-free contract validator. It parses the
CREATE TABLE definitions used in the checked-in DDL and validates the local
schema rules that govern analytics projections. It does not connect to a
catalog, object store, Spark, or an Iceberg/Delta engine.
"""
from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parents[2]
CONTRACT_DIR = ROOT / "services/python/lakehouse/contracts"
ICEBERG_FILE = CONTRACT_DIR / "iceberg_lakehouse_contracts_v1.sql"
DELTA_FILE = CONTRACT_DIR / "delta_lakehouse_contracts_v1.sql"

FORBIDDEN_MUTATIONS = re.compile(
    r"\b(?:DROP|DELETE|UPDATE|INSERT|MERGE|TRUNCATE|ALTER|CREATE\s+OR\s+REPLACE)\b",
    re.IGNORECASE,
)
CREATE_TABLE = re.compile(
    r"CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([\w.]+)\s*\((.*?)\)\s*"
    r"USING\s+([A-Za-z]+)\s*PARTITIONED\s+BY\s*\((.*?)\)\s*"
    r"TBLPROPERTIES\s*\((.*?)\)\s*;",
    re.IGNORECASE | re.DOTALL,
)
COLUMN = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s+(.+?)\s*$")
PROPERTY = re.compile(r"'([^']+)'\s*=\s*'([^']*)'")

EXPECTED_LOGICAL_TABLES = {
    "vehicle_tracker_event_v1",
    "tigerbeetle_settlement_event_v1",
    "medusa_inventory_event_v1",
    "mobility_training_features_v1",
    "ml_training_run_v1",
}

COMMON_EVENT_COLUMNS = {
    "vehicle_tracker_event_v1": {
        "event_id",
        "source_system",
        "source_event_time",
        "ingested_at",
        "event_date",
        "schema_version",
        "redaction_profile",
        "emitted_at",
    },
    "tigerbeetle_settlement_event_v1": {
        "event_id",
        "source_system",
        "source_event_time",
        "ingested_at",
        "event_date",
        "schema_version",
        "redaction_profile",
        "emitted_at",
    },
    "medusa_inventory_event_v1": {
        "event_id",
        "source_system",
        "source_event_time",
        "ingested_at",
        "event_date",
        "schema_version",
        "redaction_profile",
        "emitted_at",
    },
}

REQUIRED_COLUMNS = {
    "vehicle_tracker_event_v1": {
        "source_event_id_hash",
        "provider_kind",
        "integration_key",
        "tracker_token",
        "signal_digest_sha256",
        "consent_status",
        "redaction_profile",
    },
    "tigerbeetle_settlement_event_v1": {
        "workflow_token",
        "outbox_token",
        "debit_fsp_token",
        "settlement_state",
        "attempt_count",
    },
    "medusa_inventory_event_v1": {
        "source_event_key_hash",
        "store_token",
        "location_token",
        "inventory_item_token",
        "delivery_state",
        "payload_digest_sha256",
        "attempt_count",
    },
    "mobility_training_features_v1": {
        "feature_row_id",
        "feature_set_version",
        "subject_token",
        "source_snapshot_ref",
        "source_event_watermark",
        "consent_status",
        "feature_policy_version",
    },
    "ml_training_run_v1": {
        "run_id",
        "model_name",
        "model_version",
        "feature_set_version",
        "source_snapshot_ref",
        "source_event_watermark",
        "redaction_profile",
        "feature_policy_version",
        "code_digest_sha256",
        "container_digest",
        "run_state",
    },
}

EXPECTED_ICEBERG_PARTITIONS = {
    "vehicle_tracker_event_v1": "days(source_event_time),bucket(32,provider_kind)",
    "tigerbeetle_settlement_event_v1": "days(source_event_time),bucket(32,debit_fsp_token)",
    "medusa_inventory_event_v1": "days(source_event_time),bucket(32,store_token)",
    "mobility_training_features_v1": "days(event_date),bucket(64,feature_set_version)",
    "ml_training_run_v1": "days(training_started_at),bucket(32,model_name)",
}


@dataclass(frozen=True)
class Table:
    name: str
    columns: dict[str, str]
    engine: str
    partition: str
    properties: dict[str, str]


def normalize(value: str) -> str:
    return re.sub(r"\s+", "", value).lower()


def logical_name(table_name: str) -> str:
    return table_name.rsplit(".", maxsplit=1)[-1]


def parse_columns(block: str) -> dict[str, str]:
    columns: dict[str, str] = {}
    for definition in re.split(r",\s*(?:\n|$)", block.strip()):
        match = COLUMN.match(definition.rstrip(","))
        if not match:
            raise ValueError(f"cannot parse column definition: {definition!r}")
        name, type_definition = match.groups()
        if name in columns:
            raise ValueError(f"duplicate column declaration: {name}")
        columns[name] = normalize(type_definition)
    return columns


def parse_contract(path: Path) -> dict[str, Table]:
    text = path.read_text(encoding="utf-8")
    mutations = FORBIDDEN_MUTATIONS.findall(text)
    if mutations:
        raise ValueError(f"{path.name} contains forbidden mutation tokens: {sorted(set(mutations))}")

    tables: dict[str, Table] = {}
    for name, columns, engine, partition, properties in CREATE_TABLE.findall(text):
        key = logical_name(name)
        if key in tables:
            raise ValueError(f"{path.name} declares {key} more than once")
        tables[key] = Table(
            name=name,
            columns=parse_columns(columns),
            engine=engine.lower(),
            partition=normalize(partition),
            properties=dict(PROPERTY.findall(properties)),
        )
    if not tables:
        raise ValueError(f"{path.name} has no parseable CREATE TABLE definitions")
    return tables


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def validate_common(tables: dict[str, Table], dialect: str, errors: list[str]) -> None:
    actual = set(tables)
    require(actual == EXPECTED_LOGICAL_TABLES, f"{dialect}: expected tables {sorted(EXPECTED_LOGICAL_TABLES)}, found {sorted(actual)}", errors)
    for name, table in tables.items():
        required = REQUIRED_COLUMNS.get(name, set()) | COMMON_EVENT_COLUMNS.get(name, set())
        missing = sorted(required - set(table.columns))
        require(not missing, f"{dialect}: {name} is missing required columns {missing}", errors)
        direct_sensitive_columns = {"email", "phone", "address", "license", "vin", "latitude", "longitude"}
        require(
            not any(column.lower() in direct_sensitive_columns for column in table.columns),
            f"{dialect}: {name} contains an unbucketed or direct identifier/location column", errors,
        )
        if name.endswith("_event_v1"):
            require(table.columns.get("event_id", "").startswith("string"), f"{dialect}: {name}.event_id must be STRING", errors)
            require(table.columns.get("event_date", "").startswith("date"), f"{dialect}: {name}.event_date must be DATE", errors)


def validate_iceberg(tables: dict[str, Table], text: str, errors: list[str]) -> None:
    require("non-authoritative analytical projections" in text.lower(), "iceberg: missing non-authoritative projection declaration", errors)
    require("postgresql,\n-- tigerbeetle, and medusa remain the source systems of record" in text.lower(), "iceberg: missing source-system authority boundary", errors)
    for name, table in tables.items():
        require(table.engine == "iceberg", f"iceberg: {name} must use ICEBERG", errors)
        require(table.partition == EXPECTED_ICEBERG_PARTITIONS[name], f"iceberg: {name} partition expression differs from the local contract", errors)
        require(table.properties.get("write.format.default") == "parquet", f"iceberg: {name} must write Parquet", errors)
        require(table.properties.get("write.parquet.compression-codec") == "zstd", f"iceberg: {name} must use Zstandard compression", errors)
    require(tables["vehicle_tracker_event_v1"].properties.get("format-version") == "2", "iceberg: vehicle tracker table must use format-version 2", errors)


def validate_delta(tables: dict[str, Table], text: str, errors: list[str]) -> None:
    require("non-authoritative analytical tables only" in text.lower(), "delta: missing non-authoritative declaration", errors)
    require("do not dual-write both formats by default" in text.lower(), "delta: missing single-format deployment guard", errors)
    for name, table in tables.items():
        require(table.engine == "delta", f"delta: {name} must use DELTA", errors)
        require("event_date" in table.partition or (name == "ml_training_run_v1" and "training_started_at" in table.partition), f"delta: {name} must have an event or training-date partition", errors)
        require(table.properties.get("delta.appendOnly") == "true", f"delta: {name} must be append-only", errors)
    for name in ("vehicle_tracker_event_v1", "tigerbeetle_settlement_event_v1", "medusa_inventory_event_v1"):
        require(tables[name].properties.get("delta.enableChangeDataFeed") == "true", f"delta: {name} must enable change data feed", errors)


def validate_parity(iceberg: dict[str, Table], delta: dict[str, Table], errors: list[str]) -> None:
    for name in EXPECTED_LOGICAL_TABLES:
        if name not in iceberg or name not in delta:
            continue
        require(
            iceberg[name].columns == delta[name].columns,
            f"parity: {name} columns/types differ between Iceberg and Delta contracts",
            errors,
        )


def load_text(path: Path) -> str:
    if not path.is_file():
        raise ValueError(f"contract file does not exist: {path}")
    return path.read_text(encoding="utf-8")


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iceberg", type=Path, default=ICEBERG_FILE)
    parser.add_argument("--delta", type=Path, default=DELTA_FILE)
    args = parser.parse_args(argv)

    errors: list[str] = []
    try:
        iceberg_text = load_text(args.iceberg)
        delta_text = load_text(args.delta)
        iceberg = parse_contract(args.iceberg)
        delta = parse_contract(args.delta)
        validate_common(iceberg, "iceberg", errors)
        validate_common(delta, "delta", errors)
        validate_iceberg(iceberg, iceberg_text, errors)
        validate_delta(delta, delta_text, errors)
        validate_parity(iceberg, delta, errors)
    except ValueError as error:
        errors.append(str(error))

    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1

    print("lakehouse_open_table_contracts=PASS tables=5 dialects=2 parity=verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
