import { createHmac } from "crypto";
import { createServer } from "http";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  endpointUrl: "",
  statusCode: 204,
  request: {
    body: "",
    headers: {} as Record<string, string | string[] | undefined>,
  },
  completeCalls: [] as unknown[][],
  claim: {
    delivery_id: "11111111-1111-4111-8111-111111111111",
    endpoint_url: "",
    signing_secret_ref: "staging/developer/webhook/test",
    event_id: "22222222-2222-4222-8222-222222222222",
    event_type: "field_service.work_order.completed",
    payload: {
      workOrderId: "33333333-3333-4333-8333-333333333333",
      state: "completed",
    },
    created_at: "2026-09-06T12:00:00.000Z",
    attempt_count: 1,
    claim_token: "44444444-4444-4444-8444-444444444444",
  },
}));

vi.mock("../server/_core/env", () => ({
  ENV: {
    databaseUrl: "postgresql://disposable-test-only",
    isProduction: false,
    databaseSslCa: null,
    developerWebhookDispatchEnabled: true,
    developerWebhookSecretRefsJson: JSON.stringify({
      "staging/developer/webhook/test":
        "staging-only-webhook-signing-secret-at-least-32-bytes-long",
    }),
  },
}));

vi.mock("pg", () => ({
  Pool: class {
    async query(statement: string, values?: unknown[]) {
      if (statement.includes("developer.publish_field_service_outbox")) {
        return { rows: [{ published: 1 }], rowCount: 1 };
      }
      if (statement.includes("developer.claim_webhook_deliveries")) {
        return {
          rows: [
            {
              ...state.claim,
              endpoint_url: state.endpointUrl,
            },
          ],
          rowCount: 1,
        };
      }
      if (statement.includes("developer.complete_webhook_delivery")) {
        state.completeCalls.push(values ?? []);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected_query:${statement}`);
    }
  },
}));

import { dispatchDeveloperWebhooks } from "../server/_core/developerWebhookDispatcher";

const signingSecret =
  "staging-only-webhook-signing-secret-at-least-32-bytes-long";
let closeReceiver: (() => Promise<void>) | undefined;

async function stopReceiver() {
  if (closeReceiver) {
    await closeReceiver();
    closeReceiver = undefined;
  }
}

afterEach(async () => {
  await stopReceiver();
  state.endpointUrl = "";
  state.statusCode = 204;
  state.request = { body: "", headers: {} };
  state.completeCalls.length = 0;
});

async function listen(
  handler: Parameters<typeof createServer>[0],
  path = "/webhooks/field-service",
) {
  const receiver = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    receiver.once("error", reject);
    receiver.listen(0, "127.0.0.1", () => resolve());
  });
  const address = receiver.address();
  if (!address || typeof address === "string")
    throw new Error("receiver_address_unavailable");
  state.endpointUrl = `http://127.0.0.1:${address.port}${path}`;
  closeReceiver = () =>
    new Promise<void>((resolve, reject) =>
      receiver.close((error) => (error ? reject(error) : resolve())),
    );
}

async function startReceiver() {
  await listen((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      state.request = {
        body: Buffer.concat(chunks).toString("utf8"),
        headers: request.headers,
      };
      response.statusCode = state.statusCode;
      response.end();
    });
  });
}

async function startConnectionResetReceiver() {
  await listen(
    (request) => request.socket.destroy(),
    "/webhooks/network-reset",
  );
}

describe("developer webhook delivery dispatcher", () => {
  it("delivers a signed event and durably records a successful completion", async () => {
    await startReceiver();

    const result = await dispatchDeveloperWebhooks(1);

    expect(result).toEqual({
      published: 1,
      claimed: 1,
      delivered: 1,
      retried: 0,
    });
    expect(state.request.headers["x-delivery-id"]).toBe(
      state.claim.delivery_id,
    );
    expect(state.request.headers["x-event-id"]).toBe(state.claim.event_id);
    const expectedSignature = `sha256=${createHmac("sha256", signingSecret)
      .update(state.request.body)
      .digest("hex")}`;
    expect(state.request.headers["x-webhook-signature-256"]).toBe(
      expectedSignature,
    );
    expect(JSON.parse(state.request.body)).toMatchObject({
      id: state.claim.event_id,
      type: state.claim.event_type,
      created_at: state.claim.created_at,
      data: state.claim.payload,
    });
    expect(state.completeCalls).toEqual([
      [state.claim.delivery_id, state.claim.claim_token, true, 204, null],
    ]);
  });

  it("records a retriable delivery outcome when an endpoint rejects the signed event", async () => {
    state.statusCode = 503;
    await startReceiver();

    const result = await dispatchDeveloperWebhooks(1);

    expect(result).toEqual({
      published: 1,
      claimed: 1,
      delivered: 0,
      retried: 1,
    });
    expect(state.request.headers["x-webhook-signature-256"]).toMatch(
      /^sha256=[a-f0-9]{64}$/,
    );
    expect(state.completeCalls).toEqual([
      [
        state.claim.delivery_id,
        state.claim.claim_token,
        false,
        503,
        "endpoint_http_503",
      ],
    ]);
  });

  it("classifies a loopback connection reset as a retriable transport failure", async () => {
    await startConnectionResetReceiver();

    const result = await dispatchDeveloperWebhooks(1);

    expect(result).toEqual({
      published: 1,
      claimed: 1,
      delivered: 0,
      retried: 1,
    });
    expect(state.completeCalls).toEqual([
      [
        state.claim.delivery_id,
        state.claim.claim_token,
        false,
        599,
        "TypeError",
      ],
    ]);
  });
});
