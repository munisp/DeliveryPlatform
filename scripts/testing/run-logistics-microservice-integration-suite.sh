#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="$ROOT/validation/logistics_microservice_integration_suite_20260903"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

"$ROOT/scripts/testing/run-lagos-compliance-workflow-integration.sh"
cp "$ROOT/validation/lagos_compliance_workflow_integration_20260903/summary.json" "$OUT_DIR/compliance_summary.json"

"$ROOT/scripts/testing/run-logistics-route-plan-integration.sh"
cp "$ROOT/validation/logistics_route_plan_integration_20260903/summary.json" "$OUT_DIR/route_planning_summary.json"

node - <<'NODE' "$OUT_DIR"
const fs = require("fs");
const path = require("path");
const outputDirectory = process.argv[2];
const compliance = JSON.parse(fs.readFileSync(path.join(outputDirectory, "compliance_summary.json"), "utf8"));
const routePlanning = JSON.parse(fs.readFileSync(path.join(outputDirectory, "route_planning_summary.json"), "utf8"));
if (!compliance.passed || compliance.eligible_before_expiry !== true || compliance.eligible_after_expiry !== false || compliance.presence_after_expiry !== "compliance_suspended") {
  throw new Error("compliance workflow invariant failed");
}
if (!routePlanning.passed || routePlanning.stops < 1 || routePlanning.first_stop_kind !== "pickup" || !(routePlanning.total_distance_m >= 0)) {
  throw new Error("route planning workflow invariant failed");
}
const summary = {
  passed: true,
  suite: "logistics-microservice-integration",
  services: {
    compliance_review: compliance,
    dispatch_optimizer_route_planning: routePlanning,
  },
};
fs.writeFileSync(path.join(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
NODE

printf 'Logistics microservice integration suite passed. Evidence: %s\n' "$OUT_DIR/summary.json"
