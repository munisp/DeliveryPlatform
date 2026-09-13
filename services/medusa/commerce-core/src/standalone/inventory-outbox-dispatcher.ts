import { timingSafeEqual } from "crypto";
import { createServer } from "http";
import DeliveryPlatformInventoryOutboxService, {
  type InventoryOutboxMetrics,
} from "../modules/deliveryplatform-inventory-outbox/service";

const boundedInteger = (
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
};

const requiredSecret = (name: string): string => {
  const value = process.env[name]?.trim() || "";
  if (value.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  return value;
};

const constantTimeEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

const logger = {
  info: (message: string) => process.stdout.write(`${JSON.stringify({ level: "info", service: "medusa-inventory-outbox-dispatcher", message, at: new Date().toISOString() })}\n`),
  warn: (message: string) => process.stdout.write(`${JSON.stringify({ level: "warn", service: "medusa-inventory-outbox-dispatcher", message, at: new Date().toISOString() })}\n`),
  error: (message: string) => process.stderr.write(`${JSON.stringify({ level: "error", service: "medusa-inventory-outbox-dispatcher", message, at: new Date().toISOString() })}\n`),
};

type DeliveryOutcomes = { delivered: number; failed: number; stale: number; lastCycleDurationSeconds: number; lastCycleCompletedUnixSeconds: number };

const renderMetrics = (metrics: InventoryOutboxMetrics, outcomes: DeliveryOutcomes): string => [
  "# HELP deliveryplatform_medusa_inventory_outbox_ready_units Due, unclaimed inventory outbox rows eligible for delivery.",
  "# TYPE deliveryplatform_medusa_inventory_outbox_ready_units gauge",
  `deliveryplatform_medusa_inventory_outbox_ready_units ${metrics.readyUnits}`,
  "# HELP deliveryplatform_medusa_inventory_outbox_processing_units Inventory outbox rows currently holding a claim lease.",
  "# TYPE deliveryplatform_medusa_inventory_outbox_processing_units gauge",
  `deliveryplatform_medusa_inventory_outbox_processing_units ${metrics.processingUnits}`,
  "# HELP deliveryplatform_medusa_inventory_outbox_expired_lease_units Inventory outbox claims eligible for safe re-claim.",
  "# TYPE deliveryplatform_medusa_inventory_outbox_expired_lease_units gauge",
  `deliveryplatform_medusa_inventory_outbox_expired_lease_units ${metrics.expiredLeaseUnits}`,
  "# HELP deliveryplatform_medusa_inventory_outbox_dead_letter_units Inventory outbox rows at the terminal retry boundary.",
  "# TYPE deliveryplatform_medusa_inventory_outbox_dead_letter_units gauge",
  `deliveryplatform_medusa_inventory_outbox_dead_letter_units ${metrics.deadLetterUnits}`,
  "# HELP deliveryplatform_medusa_inventory_outbox_oldest_ready_seconds Age in seconds of the oldest inventory outbox row eligible for delivery.",
  "# TYPE deliveryplatform_medusa_inventory_outbox_oldest_ready_seconds gauge",
  `deliveryplatform_medusa_inventory_outbox_oldest_ready_seconds ${metrics.oldestReadySeconds}`,
  "# HELP deliveryplatform_medusa_inventory_outbox_pool_connections Connections currently allocated by the dispatcher outbox pool.",
  "# TYPE deliveryplatform_medusa_inventory_outbox_pool_connections gauge",
  `deliveryplatform_medusa_inventory_outbox_pool_connections{state="total"} ${metrics.poolTotal}`,
  `deliveryplatform_medusa_inventory_outbox_pool_connections{state="idle"} ${metrics.poolIdle}`,
  `deliveryplatform_medusa_inventory_outbox_pool_connections{state="waiting"} ${metrics.poolWaiting}`,
  "# HELP deliveryplatform_medusa_inventory_outbox_delivery_attempts_total Delivery attempts by terminal local outcome since dispatcher start.",
  "# TYPE deliveryplatform_medusa_inventory_outbox_delivery_attempts_total counter",
  `deliveryplatform_medusa_inventory_outbox_delivery_attempts_total{outcome="delivered"} ${outcomes.delivered}`,
  `deliveryplatform_medusa_inventory_outbox_delivery_attempts_total{outcome="failed"} ${outcomes.failed}`,
  `deliveryplatform_medusa_inventory_outbox_delivery_attempts_total{outcome="stale_fence"} ${outcomes.stale}`,
  "# HELP deliveryplatform_medusa_inventory_outbox_delivery_cycle_duration_seconds Wall-clock duration of the latest dispatcher delivery cycle.",
  "# TYPE deliveryplatform_medusa_inventory_outbox_delivery_cycle_duration_seconds gauge",
  `deliveryplatform_medusa_inventory_outbox_delivery_cycle_duration_seconds ${outcomes.lastCycleDurationSeconds}`,
  "# HELP deliveryplatform_medusa_inventory_outbox_delivery_cycle_completed_timestamp_seconds Unix timestamp of the latest completed dispatcher delivery cycle.",
  "# TYPE deliveryplatform_medusa_inventory_outbox_delivery_cycle_completed_timestamp_seconds gauge",
  `deliveryplatform_medusa_inventory_outbox_delivery_cycle_completed_timestamp_seconds ${outcomes.lastCycleCompletedUnixSeconds}`,
  "",
].join("\n");

async function main(): Promise<void> {
  if ((process.env.MEDUSA_PROCESS_ROLE || "").trim().toLowerCase() !== "inventory-dispatcher") {
    throw new Error("MEDUSA_PROCESS_ROLE must equal inventory-dispatcher for the standalone dispatcher");
  }
  const metricsToken = requiredSecret("MEDUSA_OUTBOX_METRICS_TOKEN");
  const intervalMilliseconds = boundedInteger("MEDUSA_INVENTORY_OUTBOX_INTERVAL_MS", 5_000, 1_000, 60_000);
  const port = boundedInteger("MEDUSA_INVENTORY_OUTBOX_METRICS_PORT", 9001, 1024, 65535);
  const service = new DeliveryPlatformInventoryOutboxService({ logger });
  let acceptingCycles = true;
  let activeCycle: Promise<void> | undefined;
  const outcomes: DeliveryOutcomes = {
    delivered: 0,
    failed: 0,
    stale: 0,
    lastCycleDurationSeconds: 0,
    lastCycleCompletedUnixSeconds: 0,
  };

  const deliverOnce = async (): Promise<void> => {
    if (!acceptingCycles || activeCycle) return;
    activeCycle = (async () => {
      const startedAt = Date.now();
      try {
        const result = await service.deliverPending();
        outcomes.delivered += result.delivered;
        outcomes.failed += result.failed;
        outcomes.stale += result.stale;
        if (result.claimed > 0) {
          logger.info(`claimed=${result.claimed} delivered=${result.delivered} failed=${result.failed} stale=${result.stale}`);
        }
        if (result.stale > 0) logger.warn(`claim_fence_prevented_stale_completion=${result.stale}`);
      } catch (error) {
        logger.error(`delivery_cycle_failed=${error instanceof Error ? error.message : "unknown"}`);
      } finally {
        outcomes.lastCycleDurationSeconds = (Date.now() - startedAt) / 1000;
        outcomes.lastCycleCompletedUnixSeconds = Math.floor(Date.now() / 1000);
        activeCycle = undefined;
      }
    })();
    await activeCycle;
  };

  let timer: NodeJS.Timeout | undefined;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url || "/", "http://localhost").pathname;
    if (request.method === "GET" && path === "/healthz") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok", acceptingCycles }));
      return;
    }
    const authorization = request.headers.authorization || "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (request.method !== "GET" || path !== "/metrics" || !constantTimeEqual(supplied, metricsToken)) {
      response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("unauthorized\n");
      return;
    }
    try {
      response.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
      response.end(renderMetrics(await service.metrics(), outcomes));
    } catch (error) {
      logger.error(`metrics_read_failed=${error instanceof Error ? error.message : "unknown"}`);
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("metrics unavailable\n");
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));
  logger.info(`metrics_listening_port=${port} interval_ms=${intervalMilliseconds}`);

  const shutdown = async (signal: string): Promise<void> => {
    acceptingCycles = false;
    if (timer) clearInterval(timer);
    logger.info(`shutdown_started signal=${signal}`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await activeCycle;
    await service.close();
    logger.info("shutdown_completed");
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void shutdown(signal).then(() => process.exit(0)).catch((error) => {
      logger.error(`shutdown_failed=${error instanceof Error ? error.message : "unknown"}`);
      process.exit(1);
    }));
  }
  // Signals are now armed before the first external request. This makes a
  // termination arriving during startup drain the active cycle safely.
  await deliverOnce();
  if (acceptingCycles) timer = setInterval(() => void deliverOnce(), intervalMilliseconds);
}

void main().catch((error) => {
  logger.error(error instanceof Error ? error.message : "startup_failed");
  process.exit(1);
});
