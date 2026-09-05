#!/usr/bin/env python3
"""Generate deterministic, non-sensitive settlement-report artifacts for local benchmark validation."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a deterministic settlement benchmark fixture")
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--merchant-account-id", required=True)
    parser.add_argument("--row-count", type=int, required=True)
    parser.add_argument("--report-id", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.row_count < 1 or args.row_count > 50_000:
        raise SystemExit("row-count must be between 1 and 50000")
    artifact = {
        "report_id": args.report_id,
        "row_count": args.row_count,
        "schema": "test-settlement-v1",
    }
    artifact_bytes = json.dumps(artifact, sort_keys=True, separators=(",", ":")).encode("utf-8")
    args.artifact.write_bytes(artifact_bytes)
    period_start = datetime(2026, 9, 4, tzinfo=timezone.utc)
    period_end = period_start + timedelta(days=1)
    rows = [
        {
            "source_line_no": index,
            "source_record_key": f"bench-line-{index:08d}",
            "entry_kind": "collection",
            "provider_reference": f"bench-provider-reference-{index:08d}",
            "provider_final_state": "settled",
            "provider_final_status": "success",
            "currency": "NGN",
            "gross_minor": 120000,
            "fee_minor": 5000,
            "net_minor": 115000,
            "occurred_at": (period_start + timedelta(seconds=index)).isoformat().replace("+00:00", "Z"),
            "settled_at": (period_start + timedelta(seconds=index + 60)).isoformat().replace("+00:00", "Z"),
            "normalized_metadata": {"fixture_row": index, "report_id": args.report_id},
        }
        for index in range(1, args.row_count + 1)
    ]
    manifest = {
        "merchant_account_id": args.merchant_account_id,
        "provider_report_id": args.report_id,
        "report_kind": "settlement_cycle",
        "period_start": period_start.isoformat().replace("+00:00", "Z"),
        "period_end": period_end.isoformat().replace("+00:00", "Z"),
        "retrieved_at": (period_end + timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        "source_object_ref": f"restricted/settlement/{args.report_id}.json",
        "source_content_type": "application/json",
        "source_bytes": len(artifact_bytes),
        "source_sha256": hashlib.sha256(artifact_bytes).hexdigest(),
        "retrieval_actor": "settlement-benchmark",
        "rows": rows,
    }
    args.manifest.write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
