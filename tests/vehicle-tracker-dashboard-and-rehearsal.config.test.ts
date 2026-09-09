import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("vehicle tracker Grafana dashboard and rehearsal contract", () => {
  const dashboardText = read(
    "deploy/kubernetes/monitoring/grafana-dashboards/vehicle-tracker-ingest.json",
  );
  const dashboard = JSON.parse(dashboardText) as {
    uid: string;
    schemaVersion: number;
    panels: Array<{ title: string; targets?: Array<{ expr?: string }> }>;
  };
  const monitoringKustomization = read(
    "deploy/kubernetes/monitoring/kustomization.yaml",
  );
  const workload = read("deploy/kubernetes/tracker-ingest/workloads.yaml");
  const benchmark = read(
    "scripts/testing/benchmark-vehicle-tracker-concurrency.sh",
  );

  it("has a valid, provisionable Grafana schema with a stable dashboard identity", () => {
    expect(dashboard.uid).toBe("vehicle-tracker-ingest");
    expect(dashboard.schemaVersion).toBeGreaterThanOrEqual(39);
    expect(dashboard.panels.length).toBeGreaterThanOrEqual(9);
    expect(monitoringKustomization).toContain(
      "grafana-dashboard-vehicle-tracker-ingest",
    );
    expect(monitoringKustomization).toContain('grafana_dashboard: "1"');
  });

  it("plots pool capacity, lease renewal risk, cursor stalling, locks, query latency, and error isolation", () => {
    const queries = dashboard.panels
      .flatMap((panel) => panel.targets ?? [])
      .map((target) => target.expr ?? "")
      .join("\n");
    expect(queries).toContain("sum(vehicle_tracker_pool_max_connections)");
    expect(queries).toContain(
      "vehicle_tracker_provider_cursor_lease_expires_at_seconds - time()",
    );
    expect(queries).toContain("vehicle_tracker_provider_cursor_age_seconds");
    expect(queries).toContain("vehicle_tracker_database_lock_waiting_transactions");
    expect(queries).toContain(
      "vehicle_tracker_database_query_duration_seconds_bucket",
    );
    expect(queries).toContain(
      "vehicle_tracker_provider_cursor_fence_failures_total",
    );
    expect(queries).toContain(
      "vehicle_tracker_database_query_failures_total",
    );
  });

  it("keeps the 64-replica envelope bounded and treats local worker concurrency as non-Kubernetes evidence", () => {
    expect(workload).toContain("replicas: 16");
    expect(workload).toContain("maxReplicas: 64");
    expect(workload).toContain("maxUnavailable: 25%");
    expect(workload).toContain("maxSurge: 25%");
    expect(workload).toContain("VEHICLE_TRACKER_DATABASE_POOL_MAX: \"4\"");
    expect(benchmark).toContain('WORKERS="${TRACKER_BENCH_WORKERS:-16}"');
    expect(benchmark).toContain("claim_tracker_provider_ingest");
    expect(benchmark).not.toContain("kubectl");
  });
});
