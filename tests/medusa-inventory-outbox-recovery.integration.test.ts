import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import DeliveryPlatformInventoryOutboxService, {
  type DeliveryPlatformInventoryPayload,
} from "../services/medusa/commerce-core/src/modules/deliveryplatform-inventory-outbox/service";

const databaseUrl = process.env.TEST_MEDUSA_OUTBOX_DATABASE_URL?.trim() || "";
const integrationEnabled = databaseUrl.includes("medusa_inventory_outbox_recovery_");
const describeIntegration = integrationEnabled ? describe.sequential : describe.skip;

const logger = {
  info: (_message: string) => undefined,
  warn: (_message: string) => undefined,
  error: (_message: string) => undefined,
};

const payload: DeliveryPlatformInventoryPayload = {
  type: "commerce.inventory.level.snapshot",
  data: {
    inventory_level_id: "ilevel_recovery_001",
    stock_location_id: "sloc_recovery_001",
    inventory_item_id: "iitem_recovery_001",
    stocked_quantity: 10,
    reserved_quantity: 2,
    incoming_quantity: 0,
    source_updated_at: "2026-09-09T12:00:00.000Z",
  },
};

type ClaimedEvent = {
  id: string;
  eventType: DeliveryPlatformInventoryPayload["type"];
  payload: DeliveryPlatformInventoryPayload;
  claimToken: string;
  attempts: number;
};

type ServiceInternals = {
  pool: Pool;
  claim(client: PoolClient): Promise<ClaimedEvent[]>;
  complete(event: ClaimedEvent): Promise<boolean>;
};

function internals(service: DeliveryPlatformInventoryOutboxService): ServiceInternals {
  return service as unknown as ServiceInternals;
}

async function createIngress(delayMilliseconds = 0): Promise<{
  server: Server;
  url: string;
  received: string[];
  firstRequest: Promise<void>;
}> {
  const received: string[] = [];
  let resolveFirstRequest: (() => void) | undefined;
  const firstRequest = new Promise<void>((resolve) => {
    resolveFirstRequest = resolve;
  });
  const server = createServer(async (request, response) => {
    const body: Buffer[] = [];
    request.on("data", (chunk) => body.push(Buffer.from(chunk)));
    await once(request, "end");
    received.push(Buffer.concat(body).toString("utf8"));
    resolveFirstRequest?.();
    if (delayMilliseconds > 0) await delay(delayMilliseconds);
    response.writeHead(202, { "Content-Type": "application/json" });
    response.end("{\"accepted\":true}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test ingress did not bind a TCP address");
  return { server, url: `http://127.0.0.1:${address.port}/internal/commerce/inventory`, received, firstRequest };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function forceLeaseExpired(pool: Pool, id: string): Promise<void> {
  await pool.query(
    "UPDATE deliveryplatform_inventory_outbox SET lease_expires_at = now() - interval '1 second' WHERE id = $1 AND state = 'processing'",
    [id],
  );
}

async function claimWithoutDelivery(service: DeliveryPlatformInventoryOutboxService): Promise<ClaimedEvent> {
  const client = await internals(service).pool.connect();
  try {
    await client.query("BEGIN");
    const [event] = await internals(service).claim(client);
    await client.query("COMMIT");
    if (!event) throw new Error("expected one claimed recovery-test event");
    return event;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function waitFor(predicate: () => boolean, timeoutMilliseconds: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function waitForChildExit(child: ChildProcess, timeoutMilliseconds: number): Promise<number | null> {
  return await Promise.race([
    new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    }),
    delay(timeoutMilliseconds).then(() => {
      child.kill("SIGKILL");
      throw new Error("timed out waiting for inventory dispatcher shutdown");
    }),
  ]);
}

describeIntegration("Medusa inventory dispatcher PostgreSQL recovery", () => {
  let controlPool: Pool;
  let originalEnvironment: NodeJS.ProcessEnv;
  let runningServices: DeliveryPlatformInventoryOutboxService[];

  beforeAll(async () => {
    if (!databaseUrl) return;
    originalEnvironment = { ...process.env };
    process.env.MEDUSA_DATABASE_URL = databaseUrl;
    process.env.MEDUSA_PROCESS_ROLE = "inventory-dispatcher-test";
    process.env.MEDUSA_INVENTORY_OUTBOX_POOL_MAX = "2";
    process.env.MEDUSA_INVENTORY_OUTBOX_CLAIM_LIMIT = "1";
    process.env.MEDUSA_INVENTORY_OUTBOX_LEASE_MS = "15000";
    process.env.MEDUSA_INVENTORY_OUTBOX_DELIVERY_TIMEOUT_MS = "1000";
    process.env.MEDUSA_STORE_ID = "store_recovery_001";
    process.env.DELIVERYPLATFORM_MEDUSA_WEBHOOK_SECRET = "r".repeat(48);
    controlPool = new Pool({ connectionString: databaseUrl, max: 2 });
    await controlPool.query("SELECT 1");
  });

  beforeEach(() => {
    runningServices = [];
  });

  afterEach(async () => {
    await Promise.all(runningServices.splice(0).map((service) => service.close()));
    await controlPool.query("DELETE FROM deliveryplatform_inventory_outbox");
  });

  afterAll(async () => {
    await controlPool?.end();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnvironment)) delete process.env[key];
    }
    Object.assign(process.env, originalEnvironment);
  });

  function service(): DeliveryPlatformInventoryOutboxService {
    const next = new DeliveryPlatformInventoryOutboxService({ logger });
    runningServices.push(next);
    return next;
  }

  it("allows only one current claimant, then reclaims an expired lease after simulated crash", async () => {
    const ingress = await createIngress();
    try {
      process.env.DELIVERYPLATFORM_MEDUSA_INGRESS_URL = ingress.url;
      const crashedWorker = service();
      const recoveryWorker = service();
      const outboxId = await crashedWorker.enqueue(payload);
      const claim = await claimWithoutDelivery(crashedWorker);
      expect(claim.id).toBe(outboxId);

      const competing = await recoveryWorker.deliverPending();
      expect(competing).toEqual({ claimed: 0, delivered: 0, failed: 0, stale: 0 });

      await forceLeaseExpired(controlPool, outboxId);
      const recovered = await recoveryWorker.deliverPending();
      expect(recovered).toEqual({ claimed: 1, delivered: 1, failed: 0, stale: 0 });
      expect(ingress.received).toHaveLength(1);
      const state = await controlPool.query<{ state: string; attempts: number }>(
        "SELECT state, attempts FROM deliveryplatform_inventory_outbox WHERE id = $1",
        [outboxId],
      );
      expect(state.rows[0]).toEqual({ state: "delivered", attempts: 2 });
    } finally {
      await closeServer(ingress.server);
    }
  });

  it("recovers a leased row after the claiming worker loses its PostgreSQL backend connection", async () => {
    const ingress = await createIngress();
    const crashedWorker = service();
    const recoveryWorker = service();
    let claimClient: PoolClient | undefined;
    try {
      process.env.DELIVERYPLATFORM_MEDUSA_INGRESS_URL = ingress.url;
      const outboxId = await crashedWorker.enqueue(payload);
      claimClient = await internals(crashedWorker).pool.connect();
      const pidResult = await claimClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const backendPid = pidResult.rows[0]?.pid;
      if (!backendPid) throw new Error("claiming worker did not expose a PostgreSQL backend PID");
      await claimClient.query("BEGIN");
      const claimed = await internals(crashedWorker).claim(claimClient);
      await claimClient.query("COMMIT");
      expect(claimed).toHaveLength(1);

      const terminated = await controlPool.query<{ terminated: boolean }>("SELECT pg_terminate_backend($1) AS terminated", [backendPid]);
      expect(terminated.rows[0]?.terminated).toBe(true);
      await expect(claimClient.query("SELECT 1")).rejects.toThrow();
      claimClient.release();
      claimClient = undefined;

      await forceLeaseExpired(controlPool, outboxId);
      expect(await recoveryWorker.deliverPending()).toEqual({ claimed: 1, delivered: 1, failed: 0, stale: 0 });
      const state = await controlPool.query<{ state: string; attempts: number }>(
        "SELECT state, attempts FROM deliveryplatform_inventory_outbox WHERE id = $1",
        [outboxId],
      );
      expect(state.rows[0]).toEqual({ state: "delivered", attempts: 2 });
      expect(ingress.received).toHaveLength(1);
    } finally {
      claimClient?.release(true);
      await closeServer(ingress.server);
    }
  });

  it("reclaims an expired claim when a partitioned delivery request cannot complete, fencing the stale worker", async () => {
    const received: string[] = [];
    let resolveFirstRequest: (() => void) | undefined;
    const firstRequest = new Promise<void>((resolve) => { resolveFirstRequest = resolve; });
    const ingress = createServer(async (request, response) => {
      const body: Buffer[] = [];
      request.on("data", (chunk) => body.push(Buffer.from(chunk)));
      await once(request, "end");
      received.push(Buffer.concat(body).toString("utf8"));
      if (received.length === 1) {
        resolveFirstRequest?.();
        // Deliberately never respond: this is a disposable transport blackhole,
        // not a claim-row mutation. The client timeout represents the partition.
        const safetyClose = setTimeout(() => request.socket.destroy(), 2_000);
        request.once("close", () => clearTimeout(safetyClose));
        return;
      }
      response.writeHead(202, { "Content-Type": "application/json" });
      response.end("{\"accepted\":true}");
    });
    ingress.listen(0, "127.0.0.1");
    await once(ingress, "listening");
    const address = ingress.address();
    if (!address || typeof address === "string") throw new Error("partition ingress did not bind a TCP address");
    const ingressUrl = `http://127.0.0.1:${address.port}/internal/commerce/inventory`;
    try {
      process.env.DELIVERYPLATFORM_MEDUSA_INGRESS_URL = ingressUrl;
      const partitionedWorker = service();
      const replacementWorker = service();
      const outboxId = await partitionedWorker.enqueue(payload);
      const partitionedDelivery = partitionedWorker.deliverPending();
      await firstRequest;

      // The test fixture advances only the lease clock. It never grants the
      // partitioned process a new token or modifies its intended completion.
      await forceLeaseExpired(controlPool, outboxId);
      expect(await replacementWorker.deliverPending()).toEqual({ claimed: 1, delivered: 1, failed: 0, stale: 0 });
      expect(await partitionedDelivery).toEqual({ claimed: 1, delivered: 0, failed: 0, stale: 1 });

      const state = await controlPool.query<{ state: string; attempts: number; claim_token: string | null }>(
        "SELECT state, attempts, claim_token FROM deliveryplatform_inventory_outbox WHERE id = $1",
        [outboxId],
      );
      expect(state.rows[0]).toEqual({ state: "delivered", attempts: 2, claim_token: null });
      expect(received).toHaveLength(2);
    } finally {
      ingress.closeAllConnections();
      await closeServer(ingress);
    }
  });

  it("rejects stale completion after a replacement worker reclaims and delivers the expired lease", async () => {
    const ingress = await createIngress();
    try {
      process.env.DELIVERYPLATFORM_MEDUSA_INGRESS_URL = ingress.url;
      const staleWorker = service();
      const replacementWorker = service();
      const outboxId = await staleWorker.enqueue(payload);
      const staleClaim = await claimWithoutDelivery(staleWorker);
      await forceLeaseExpired(controlPool, outboxId);

      expect(await replacementWorker.deliverPending()).toEqual({ claimed: 1, delivered: 1, failed: 0, stale: 0 });
      expect(await internals(staleWorker).complete(staleClaim)).toBe(false);
      const state = await controlPool.query<{ state: string; claim_token: string | null }>(
        "SELECT state, claim_token FROM deliveryplatform_inventory_outbox WHERE id = $1",
        [outboxId],
      );
      expect(state.rows[0]).toEqual({ state: "delivered", claim_token: null });
      expect(ingress.received).toHaveLength(1);
    } finally {
      await closeServer(ingress.server);
    }
  });

  it("drains the active delivery on SIGTERM, then exits without claiming another row", async () => {
    const ingress = await createIngress(350);
    const metricsPort = 19000 + Math.floor(Math.random() * 1000);
    let child: ChildProcess | undefined;
    try {
      const setupService = service();
      const first = await setupService.enqueue(payload);
      await setupService.enqueue({
        ...payload,
        data: { ...payload.data, inventory_level_id: "ilevel_recovery_002", source_updated_at: "2026-09-09T12:01:00.000Z" },
      });
      await setupService.close();
      runningServices = runningServices.filter((candidate) => candidate !== setupService);

      const childEnvironment = {
        ...process.env,
        MEDUSA_DATABASE_URL: databaseUrl,
        MEDUSA_PROCESS_ROLE: "inventory-dispatcher",
        MEDUSA_INVENTORY_OUTBOX_POOL_MAX: "2",
        MEDUSA_INVENTORY_OUTBOX_CLAIM_LIMIT: "1",
        MEDUSA_INVENTORY_OUTBOX_LEASE_MS: "15000",
        MEDUSA_INVENTORY_OUTBOX_DELIVERY_TIMEOUT_MS: "1000",
        MEDUSA_INVENTORY_OUTBOX_INTERVAL_MS: "60000",
        MEDUSA_INVENTORY_OUTBOX_METRICS_PORT: String(metricsPort),
        MEDUSA_OUTBOX_METRICS_TOKEN: "m".repeat(48),
        MEDUSA_STORE_ID: "store_recovery_001",
        DELIVERYPLATFORM_MEDUSA_INGRESS_URL: ingress.url,
        DELIVERYPLATFORM_MEDUSA_WEBHOOK_SECRET: "r".repeat(48),
      };
      child = spawn(process.execPath, ["--import", "tsx", "src/standalone/inventory-outbox-dispatcher.ts"], {
        cwd: `${process.cwd()}/services/medusa/commerce-core`,
        env: childEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const logs: string[] = [];
      child.stdout?.on("data", (chunk) => logs.push(chunk.toString("utf8")));
      child.stderr?.on("data", (chunk) => logs.push(chunk.toString("utf8")));

      await ingress.firstRequest;
      child.kill("SIGTERM");
      const exitCode = await waitForChildExit(child, 10_000);
      expect(exitCode).toBe(0);
      await waitFor(() => logs.join("").includes("shutdown_completed"), 1_000, "dispatcher shutdown completion log");

      const rows = await controlPool.query<{ id: string; state: string }>(
        "SELECT id, state FROM deliveryplatform_inventory_outbox ORDER BY created_at ASC",
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0]).toEqual({ id: first, state: "delivered" });
      expect(rows.rows[1]?.state).toBe("pending");
      expect(ingress.received).toHaveLength(1);
    } finally {
      child?.kill("SIGKILL");
      await closeServer(ingress.server);
    }
  });
});
