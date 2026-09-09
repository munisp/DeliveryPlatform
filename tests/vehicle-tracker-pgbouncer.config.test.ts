import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("vehicle tracker PgBouncer transaction-pooling contract", () => {
  const pooler = read("deploy/kubernetes/tracker-pgbouncer/workloads.yaml");
  const worker = read("deploy/kubernetes/tracker-ingest/workloads.yaml");
  const monitoring = read("deploy/kubernetes/monitoring/vehicle-tracker-pgbouncer-monitoring.yaml");
  const rules = read("deploy/kubernetes/monitoring/prometheus-rules.yaml");
  const client = read("server/_core/vehicleAccess.ts");
  const bulkAuthority = read("drizzle/0061_vehicle_tracker_bulk_idempotency.sql");

  it("uses transaction pooling with bounded client and PostgreSQL backend limits", () => {
    expect(pooler).toContain("pool_mode = transaction");
    expect(pooler).toContain("max_client_conn = 128");
    expect(pooler).toContain("max_db_connections = 20");
    expect(pooler).toContain("max_db_client_connections = 96");
    expect(pooler).toContain("default_pool_size = 16");
    expect(pooler).toContain("reserve_pool_size = 4");
    expect(pooler).toContain("max_prepared_statements = 0");
    expect(pooler).toContain("server_reset_query = DISCARD ALL");
  });

  it("preserves a transaction-scoped authority model rather than session state", () => {
    expect(bulkAuthority).toContain("pg_advisory_xact_lock");
    expect(client).toContain('application_name: "vehicle-tracker-ingest"');
    expect(client).not.toContain("LISTEN");
    expect(client).not.toContain("PREPARE ");
    expect(worker).toContain("vehicle-tracker-pgbouncer-client");
    expect(worker).toContain("VEHICLE_TRACKER_DATABASE_POOL_MAX: \"4\"");
  });

  it("requires encrypted and separately authenticated pooler and exporter connections", () => {
    expect(pooler).toContain("auth_type = scram-sha-256");
    expect(pooler).toContain("client_tls_sslmode = require");
    expect(pooler).toContain("server_tls_sslmode = verify-full");
    expect(pooler).toContain("stats_users = tracker_pgbouncer_exporter");
    expect(pooler).toContain("ignore_startup_parameters = extra_float_digits");
    expect(monitoring).toContain("interval: 15s");
    expect(monitoring).toContain("scheme: https");
    expect(monitoring).toContain("basicAuth:");
  });

  it("alerts on exporter loss, queue depth, client saturation, backend exhaustion, and sustained wait time", () => {
    for (const alert of [
      "VehicleTrackerPgBouncerExporterDown",
      "VehicleTrackerPgBouncerClientQueue",
      "VehicleTrackerPgBouncerClientMaxWait",
      "VehicleTrackerPgBouncerClientSaturation",
      "VehicleTrackerPgBouncerBackendExhaustion",
      "VehicleTrackerPgBouncerWaitRateElevated",
    ]) {
      expect(rules).toContain(`alert: ${alert}`);
    }
    expect(rules).toContain("pgbouncer_pools_client_waiting_connections");
    expect(rules).toContain("pgbouncer_pools_client_maxwait_seconds");
    expect(rules).toContain("pgbouncer_config_max_client_connections");
    expect(rules).toContain("pgbouncer_stats_client_wait_seconds_total");
    expect(rules).toContain("sum(vehicle_tracker_pgbouncer_server_connections) / 80");
  });
});
