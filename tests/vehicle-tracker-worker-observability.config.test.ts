import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("vehicle tracker dedicated-worker observability configuration", () => {
  const worker = read("server/workers/vehicleTrackerIngestWorker.ts");
  const metrics = read("server/_core/vehicleTrackerMetrics.ts");
  const store = read("server/_core/vehicleAccess.ts");
  const env = read("server/_core/env.ts");
  const migration = read(
    "drizzle/0062_vehicle_tracker_worker_observability.sql",
  );
  const workload = read("deploy/kubernetes/tracker-ingest/workloads.yaml");
  const monitoring = read(
    "deploy/kubernetes/monitoring/vehicle-tracker-ingest-monitoring.yaml",
  );
  const rules = read("deploy/kubernetes/monitoring/prometheus-rules.yaml");
  const central = read("server/_core/index.ts");

  it("uses a standalone health and metrics process instead of running consumers in every API pod", () => {
    expect(worker).toContain('request.url === "/metrics"');
    expect(worker).toContain('request.url === "/healthz"');
    expect(worker).toContain("startVehicleTrackerProviderConsumers");
    expect(worker).toContain("closeVehicleTrackerPool");
    expect(central).toContain("ENV.vehicleTrackerConsumerEmbedded");
    expect(central).toContain('workerIdPrefix: "central-app"');
    expect(env).toContain("VEHICLE_TRACKER_CONSUMER_EMBEDDED");
    expect(env).toContain("VEHICLE_TRACKER_WORKER_METRICS_PORT");
  });

  it("bounds per-worker database use and exports lease, pool, query, and lock metrics", () => {
    expect(env).toContain('"VEHICLE_TRACKER_DATABASE_POOL_MAX"');
    expect(env).toContain("4,\n    4,\n    8");
    expect(store).toContain('application_name: "vehicle-tracker-ingest"');
    // Perf finding 10: env knob is hard-capped at 5 connections with a 3s
    // connect timeout and a server-side statement_timeout.
    expect(store).toContain("max: Math.min(ENV.vehicleTrackerDatabasePoolMax, 5)");
    expect(store).toContain("connectionTimeoutMillis: 3000");
    expect(metrics).toContain("vehicle_tracker_pool_connections");
    expect(metrics).toContain(
      "vehicle_tracker_database_query_duration_seconds",
    );
    expect(metrics).toContain(
      "vehicle_tracker_database_lock_waiting_transactions",
    );
    expect(metrics).toContain(
      "vehicle_tracker_provider_cursor_lease_expires_at_seconds",
    );
  });

  it("retains function-only least privilege and fails lock observability closed without PostgreSQL monitoring rights", () => {
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("pg_read_all_stats");
    expect(migration).toContain("pg_monitor");
    expect(migration).toContain("ERRCODE = '42501'");
    expect(migration).toContain("REVOKE ALL ON FUNCTION");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION");
    expect(worker).toContain("available: false");
  });

  it("defines a 15-second scrape and a guarded 16-to-64 replica deployment", () => {
    expect(monitoring).toContain("interval: 15s");
    expect(monitoring).toContain("scrapeTimeout: 10s");
    expect(monitoring).toContain("namespaceSelector");
    expect(workload).toContain("replicas: 16");
    expect(workload).toContain("minReplicas: 16");
    expect(workload).toContain("maxReplicas: 64");
    expect(workload).toContain('VEHICLE_TRACKER_DATABASE_POOL_MAX: "4"');
    expect(workload).toContain('memory: "384Mi"');
    expect(workload).toContain('memory: "768Mi"');
    expect(workload).toContain("automountServiceAccountToken: false");
    expect(workload).toContain("readOnlyRootFilesystem: true");
  });

  it("alerts on renewal risk, stalled cursors, fences, pool pressure, lock waits, and missing telemetry", () => {
    expect(rules).toContain("VehicleTrackerLeaseRenewalAtRisk");
    expect(rules).toContain("VehicleTrackerCursorStalled");
    expect(rules).toContain("VehicleTrackerCursorFenceFailures");
    expect(rules).toContain("VehicleTrackerPoolSaturated");
    expect(rules).toContain("VehicleTrackerDatabaseLockWait");
    expect(rules).toContain("VehicleTrackerMetricsMissing");
    expect(rules).toContain(
      "vehicle_tracker_provider_cursor_lease_expires_at_seconds - time() < 45",
    );
    expect(rules).toContain(
      "increase(vehicle_tracker_provider_cursor_fence_failures_total[5m]) >= 3",
    );
  });
});
