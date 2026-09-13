import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("financial and Medusa outbox queue-scaling contract", () => {
  const migration = read("drizzle/0063_financial_outbox_autoscaling_metrics.sql");
  const mojaloopMetrics = read("services/go/mojaloop/funds_outbox_metrics.go");
  const mojaloopMain = read("services/go/mojaloop/main.go");
  const financialWorker = read("deploy/kubernetes/outbox-autoscaling/financial-outbox-worker.yaml");
  const financialKeda = read("deploy/kubernetes/outbox-autoscaling/financial-outbox-keda.yaml");
  const medusaConfig = read("services/medusa/commerce-core/medusa-config.js");
  const medusaOutbox = read("services/medusa/commerce-core/src/modules/deliveryplatform-inventory-outbox/service.ts");
  const medusaJob = read("services/medusa/commerce-core/src/jobs/deliver-deliveryplatform-inventory-outbox.ts");
  const dispatcher = read("services/medusa/commerce-core/src/standalone/inventory-outbox-dispatcher.ts");
  const workerSupervisor = read("services/medusa/commerce-core/src/standalone/medusa-worker-supervisor.ts");
  const medusaWorkloads = read("deploy/kubernetes/medusa-commerce/workloads.yaml");
  const medusaKeda = read("deploy/kubernetes/medusa-commerce/inventory-outbox-keda.yaml");

  it("uses a restricted aggregate financial read model rather than exposing financial identifiers", () => {
    expect(migration).toContain("mojaloop_outbox_autoscaling_metrics");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path = pg_catalog, public");
    expect(migration).toContain("REVOKE ALL ON FUNCTION");
    expect(migration).toContain("ledger_transfer_lane");
    expect(migration).toContain("earlier.ledger_debit_fsp = o.ledger_debit_fsp");
    expect(migration).not.toContain("RETURNS TABLE(\n  ledger_debit_fsp");
    expect(mojaloopMetrics).toContain("public.mojaloop_outbox_autoscaling_metrics");
    expect(mojaloopMetrics).toContain("requireMetricsAccess");
    expect(mojaloopMetrics).toContain("ConstantTimeCompare");
    expect(mojaloopMain).toContain('"/metrics/funds-outbox"');
    expect(mojaloopMain).toContain("MOJALOOP_DATABASE_POOL_MAX");
  });

  it("scales only a dedicated financial worker from precomputed eligible work", () => {
    expect(financialWorker).toContain("MOJALOOP_SERVICE_MODE");
    expect(financialWorker).toContain("outbox-worker");
    expect(financialWorker).toContain('MOJALOOP_DATABASE_POOL_MAX\n              value: "4"');
    expect(financialKeda).toContain("deliveryplatform_funds_outbox_ready_units_global");
    expect(financialKeda).toContain("max by (work_class)");
    expect(financialKeda).toContain("currentReplicasIfHigher");
    expect(financialKeda).toContain("maxReplicaCount: 4");
    expect(financialKeda).toContain('threshold: "20"');
    expect(financialKeda).not.toContain("ledger_debit_fsp");
  });

  it("separates Medusa server, worker, and inventory dispatcher roles with bounded pools", () => {
    expect(medusaConfig).toContain("workerMode");
    expect(medusaConfig).toContain("MEDUSA_FRAMEWORK_DB_POOL_MAX");
    expect(medusaConfig).toContain("idle_in_transaction_session_timeout");
    expect(medusaOutbox).toContain("MEDUSA_INVENTORY_OUTBOX_POOL_MAX");
    expect(medusaOutbox).toContain("safeSequentialMaximum");
    expect(medusaOutbox).toContain("this.runtime.claimLimit");
    expect(medusaOutbox).toContain("client.release();");
    expect(medusaOutbox).toContain("async metrics()");
    expect(medusaJob).toContain('MEDUSA_PROCESS_ROLE || "").trim().toLowerCase() !== "inventory-dispatcher"');
    expect(dispatcher).toContain('MEDUSA_PROCESS_ROLE must equal inventory-dispatcher');
    expect(dispatcher).toContain("claim_fence_prevented_stale_completion");
    expect(dispatcher).toContain("MEDUSA_OUTBOX_METRICS_TOKEN");
    expect(workerSupervisor).toContain('MEDUSA_WORKER_MODE: "worker"');
    expect(workerSupervisor).toContain("SIGKILL");
    expect(workerSupervisor).toContain("process.exit(1)");
    expect(medusaWorkloads).toContain("name: medusa-server");
    expect(medusaWorkloads).toContain("name: medusa-worker");
    expect(medusaWorkloads).toContain("name: medusa-inventory-outbox");
    expect(medusaWorkloads).toContain('command: ["npm", "run", "start:worker-supervisor"]');
  });

  it("uses an aggregate identifier-free inventory readiness gauge for KEDA", () => {
    expect(medusaKeda).toContain("deliveryplatform_medusa_inventory_outbox_ready_units_global");
    expect(medusaKeda).toContain("max(deliveryplatform_medusa_inventory_outbox_ready_units)");
    expect(medusaKeda).toContain("currentReplicasIfHigher");
    expect(medusaKeda).toContain("maxReplicaCount: 4");
    expect(medusaKeda).toContain('threshold: "10"');
    expect(medusaKeda).toContain("DeliveryPlatformMedusaInventoryLeaseExpired");
    expect(medusaKeda).not.toContain("reservation_id");
    expect(medusaKeda).not.toContain("order_id");
  });
});
