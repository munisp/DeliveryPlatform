import { createServer } from "node:http";
import { hostname } from "node:os";

import { ENV } from "../_core/env";
import {
  closeVehicleTrackerPool,
  getVehicleTrackerDatabaseLockMetrics,
  getVehicleTrackerPoolSnapshot,
  listVehicleTrackerProviderIngestObservability,
} from "../_core/vehicleAccess";
import { vehicleTrackerMetrics } from "../_core/vehicleTrackerMetrics";
import { startVehicleTrackerProviderConsumers } from "../_core/vehicleTrackerProviderConsumers";

function workerIdentity() {
  const raw = process.env.VEHICLE_TRACKER_WORKER_ID?.trim() || hostname();
  const normalized = raw.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 96);
  return normalized.length >= 3 ? normalized : "vehicle-tracker-worker";
}

async function refreshLeaseMetrics() {
  // Remove prior work-lane samples before querying PostgreSQL. If the query
  // fails, Prometheus sees a missing series rather than stale scale-out data.
  vehicleTrackerMetrics.resetProviderOverdueCursors();
  const leases = await listVehicleTrackerProviderIngestObservability();
  for (const lease of leases) {
    vehicleTrackerMetrics.setLeaseState(lease);
    vehicleTrackerMetrics.setProviderOverdueCursor({
      providerKind: lease.providerKind,
      integrationKey: lease.integrationKey,
      cursorAgeSeconds: lease.cursorAgeSeconds,
      pollIntervalMs: ENV.vehicleTrackerProviderPollIntervalMs,
      namespace: ENV.vehicleTrackerMetricsNamespace,
    });
  }
  try {
    const lockState = await getVehicleTrackerDatabaseLockMetrics();
    vehicleTrackerMetrics.setDatabaseLockState({
      ...lockState,
      available: true,
    });
  } catch {
    vehicleTrackerMetrics.setDatabaseLockState({
      activeTransactions: 0,
      lockWaitingTransactions: 0,
      maxLockWaitSeconds: 0,
      available: false,
    });
  }
  const pool = getVehicleTrackerPoolSnapshot();
  vehicleTrackerMetrics.setPool(pool.total, pool.idle, pool.waiting, pool.max);
}

async function main() {
  if (!ENV.vehicleTrackerProviderConsumersEnabled) {
    throw new Error("vehicle_tracker_provider_consumers_disabled");
  }
  if (ENV.vehicleTrackerConsumerEmbedded) {
    throw new Error(
      "vehicle_tracker_consumer_embedded_mode_conflicts_with_worker",
    );
  }

  const identity = workerIdentity();
  const stopConsumers = startVehicleTrackerProviderConsumers({
    workerIdPrefix: identity,
  });

  const refresh = () => {
    void refreshLeaseMetrics().catch(() => {
      // Database query failure is exposed by the query-failure counter after a pool exists.
      // The next 15-second refresh and the consumer retry path remain fail-closed.
    });
  };
  refresh();
  const leaseTimer = setInterval(refresh, 15_000);

  const metricsServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/metrics") {
      response.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(vehicleTrackerMetrics.render());
      return;
    }
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", worker: identity }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve, reject) => {
    metricsServer.once("error", reject);
    metricsServer.listen(ENV.vehicleTrackerWorkerMetricsPort, "0.0.0.0", () => {
      metricsServer.off("error", reject);
      resolve();
    });
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(leaseTimer);
    stopConsumers();
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    metricsServer.close(() => {
      void closeVehicleTrackerPool().finally(() => {
        clearTimeout(forceExit);
        process.exit(0);
      });
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

void main().catch((error) => {
  const code =
    error instanceof Error
      ? error.message
      : "vehicle_tracker_worker_start_failed";
  process.stderr.write(`vehicle_tracker_worker_start_failed code=${code}\n`);
  process.exit(1);
});
