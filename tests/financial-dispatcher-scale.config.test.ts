import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("financial dispatcher scale contracts", () => {
  it("keeps payment PgBouncer in transaction mode with bounded backend capacity", () => {
    const manifest = read("deploy/kubernetes/financial-pgbouncer/workloads.yaml");
    expect(manifest).toContain("pool_mode = transaction");
    expect(manifest).toContain("max_prepared_statements = 0");
    expect(manifest).toContain("server_reset_query = DISCARD ALL");
    expect(manifest).toContain("max_db_connections = 28");
    expect(manifest).toContain("max_client_conn = 192");
    expect(manifest).toContain("replicas: 3");
    expect(manifest).toContain("maxSurge: 0");
    expect(manifest).toContain("max_connections = 150");
    expect(manifest).toContain("superuser_reserved_connections = 10");
    expect(manifest).toContain("client_tls_sslmode = require");
    expect(manifest).toContain("server_tls_sslmode = verify-full");
  });

  it("keeps the financial worker lane and database-pool budgets explicit", () => {
    const runtime = read("deploy/kubernetes/go-services/runtime-config.yaml");
    expect(runtime).toContain('FUNDS_OUTBOX_TIGERBEETLE_LANES: "4"');
    expect(runtime).toContain('FUNDS_OUTBOX_TIGERBEETLE_BATCH_MIN: "64"');
    expect(runtime).toContain('FUNDS_OUTBOX_TIGERBEETLE_BATCH_MAX: "256"');
    expect(runtime).toContain('FINANCIAL_DB_MAX_OPEN_CONNS: "24"');
    expect(runtime).toContain('FINANCIAL_DB_MAX_IDLE_CONNS: "8"');
  });

  it("requires the additive lane indexes and the acknowledgement-gated rehearsal", () => {
    const migration = read("drizzle/0070_financial_partitioned_tigerbeetle_dispatch.sql");
    const runner = read("scripts/testing/run-financial-dispatcher-load-rehearsal.sh");
    expect(migration).toContain("idx_mojaloop_funds_outbox_tigerbeetle_lane_ready");
    expect(migration).toContain("idx_mojaloop_funds_outbox_tigerbeetle_lane_reclaim");
    expect(migration).toContain("mojaloop_funds', 9");
    expect(runner).toContain("ALLOW_FINANCIAL_DISPATCHER_LOAD_REHEARSAL");
    expect(runner).toContain("I_UNDERSTAND_THIS_RUNS_A_DISPOSABLE_FINANCIAL_LOAD_REHEARSAL");
    expect(runner).toContain("financial-load-lanes");
  });
});
