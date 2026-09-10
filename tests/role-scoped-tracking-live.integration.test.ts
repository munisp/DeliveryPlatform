import express from "express";
import { once } from "node:events";
import { request, type IncomingMessage, type Server } from "node:http";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "../server/_core/trpc";

const RUN_MARKER = "I_UNDERSTAND_THIS_USES_A_DISPOSABLE_LOCAL_POSTGIS_DATABASE";
const databaseUrl = process.env.DATABASE_URL ?? "";
const enabled = process.env.RUN_ROLE_SCOPED_TRACKING_LIVE_INTEGRATION === RUN_MARKER && databaseUrl.length > 0;
const describeLive = enabled ? describe : describe.skip;

const users = new Map<number, SessionUser>([
  [1, { id: 1, name: "Admin", role: "admin", openId: "admin-open-id" }],
  [2, { id: 2, name: "Customer", role: "customer", openId: "customer-open-id" }],
  [3, { id: 3, name: "Merchant", role: "merchant", openId: "merchant-open-id" }],
  [4, { id: 4, name: "Driver", role: "driver", openId: "driver-open-id" }],
  [5, { id: 5, name: "Viewer", role: "viewer", openId: "viewer-open-id" }],
]);

function resolver(headers: Record<string, string | string[] | undefined>) {
  const raw = headers["x-test-user-id"];
  const id = Number(Array.isArray(raw) ? raw[0] : raw);
  return Promise.resolve(users.get(id) ?? null);
}

function headers(userId?: number) {
  return userId === undefined ? {} : { "x-test-user-id": `${userId}` };
}

type SseEvent = { event: string; data: unknown };

type SseReader = {
  next: (timeoutMs?: number) => Promise<SseEvent>;
  close: () => void;
};

function parseSseFrame(frame: string): SseEvent {
  const event = frame.match(/^event: (.+)$/m)?.[1] ?? "message";
  const rawData = frame.match(/^data: (.+)$/m)?.[1] ?? "null";
  return { event, data: JSON.parse(rawData) };
}

function createSseReader(response: IncomingMessage): SseReader {
  let buffer = "";
  const queue: SseEvent[] = [];
  const waiters: Array<{ resolve: (event: SseEvent) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  const drain = () => {
    for (;;) {
      const separator = buffer.indexOf("\n\n");
      if (separator < 0) return;
      const event = parseSseFrame(buffer.slice(0, separator));
      buffer = buffer.slice(separator + 2);
      const waiter = waiters.shift();
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(event); }
      else queue.push(event);
    }
  };
  response.setEncoding("utf8");
  response.on("data", (chunk: string) => { buffer += chunk; drain(); });
  response.on("error", (error) => {
    for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
  });
  response.on("close", () => {
    for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new Error("sse_stream_closed_before_event")); }
  });
  return {
    next: (timeoutMs = 7_500) => {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("sse_event_timeout"));
        }, timeoutMs);
        waiters.push({ resolve, reject, timer });
      });
    },
    close: () => response.destroy(),
  };
}

async function openSse(url: string, userId: number) {
  return new Promise<{ status: number; contentType: string; reader: SseReader }>((resolve, reject) => {
    const streamRequest = request(url, { headers: headers(userId) }, (response) => {
      resolve({
        status: response.statusCode ?? 0,
        contentType: response.headers["content-type"] ?? "",
        reader: createSseReader(response),
      });
    });
    streamRequest.once("error", reject);
    streamRequest.end();
  });
}

describeLive("role-scoped tracking snapshot HTTP and SSE handoff", () => {
  let server: Server;
  let baseUrl = "";
  let pool: Pool;
  let closeRoleScopedTrackingPoolForTest: () => Promise<void>;

  beforeAll(async () => {
    const tracking = await import("../server/_core/realtimeTracking");
    closeRoleScopedTrackingPoolForTest = tracking.closeRoleScopedTrackingPoolForTest;
    const app = express();
    app.get("/api/tracking/live/:scope/snapshot", (req, res) => {
      void tracking.handleRoleScopedTrackingSnapshot(req, res, resolver);
    });
    app.get("/api/tracking/live/:scope", (req, res) => {
      void tracking.handleRoleScopedTrackingStream(req, res, resolver);
    });
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("integration_listener_unavailable");
    baseUrl = `http://127.0.0.1:${address.port}`;
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await pool.query(
      "INSERT INTO public.delivery_tracking_events(delivery_id,occurred_at,latitude,longitude,accuracy_meters) VALUES ($1,$2,$3,$4,$5)",
      ["100", "2026-09-10T10:00:00.000Z", 6.5244, 3.3792, 9],
    );
  });

  afterAll(async () => {
    await closeRoleScopedTrackingPoolForTest?.();
    await pool?.end();
    if (server) {
      server.close();
      await once(server, "close");
    }
  });

  it("requires a session and returns an authorized no-store snapshot with its cursor watermark", async () => {
    const unauthenticated = await fetch(`${baseUrl}/api/tracking/live/me/snapshot`);
    expect(unauthenticated.status).toBe(401);

    const response = await fetch(`${baseUrl}/api/tracking/live/me/snapshot`, { headers: headers(2) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toMatchObject({
      cursor: 1,
      truncated: false,
      deltas: [{ cursor: 1, orderId: 100, latitude: 6.5244, longitude: 3.3792 }],
    });
  });

  it("denies an administrator scope to a non-administrator", async () => {
    const response = await fetch(`${baseUrl}/api/tracking/live/admin/snapshot`, { headers: headers(5) });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "tracking_scope_denied" });
  });

  it("hands the snapshot cursor to SSE and delivers only the subsequently appended delta", async () => {
    const snapshotResponse = await fetch(`${baseUrl}/api/tracking/live/me/snapshot`, { headers: headers(2) });
    const snapshot = await snapshotResponse.json() as { cursor: number };
    expect(snapshot.cursor).toBe(1);

    const stream = await openSse(`${baseUrl}/api/tracking/live/me?cursor=${snapshot.cursor}`, 2);
    expect(stream.status).toBe(200);
    expect(stream.contentType).toContain("text/event-stream");
    const ready = await stream.reader.next();
    expect(ready).toMatchObject({ event: "ready", data: { cursor: 1 } });

    const notificationStartedAt = Date.now();
    await pool.query(
      "INSERT INTO public.delivery_tracking_events(delivery_id,occurred_at,latitude,longitude,accuracy_meters) VALUES ($1,$2,$3,$4,$5)",
      ["100", "2026-09-10T10:01:00.000Z", 6.525, 3.38, 7],
    );

    let delta: SseEvent | null = null;
    for (let attempts = 0; attempts < 3; attempts += 1) {
      const event = await stream.reader.next();
      if (event.event === "tracking.delta") {
        delta = event;
        break;
      }
    }
    expect(Date.now() - notificationStartedAt).toBeLessThan(1_500);
    expect(delta).toMatchObject({
      event: "tracking.delta",
      data: {
        cursor: 2,
        deltas: [{ cursor: 2, orderId: 100, latitude: 6.525, longitude: 3.38 }],
      },
    });
    stream.reader.close();
  }, 6_000);
});
