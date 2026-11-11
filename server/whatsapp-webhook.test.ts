/**
 * Tests for the WhatsApp Cloud API webhook skeleton (P1-B).
 *
 * Covers: GET verification handshake (ok/denied), POST HMAC accept/reject
 * with real in-test HMAC-SHA256 signatures, 503 fail-closed when the app
 * secret is unset, inbound dedupe replay (processes exactly once), session
 * state transitions (main_menu → browse → cart), and sender fail-closed
 * behaviour when credentials are unset.
 */

import { createHmac } from "crypto";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterEach, describe, expect, it, vi } from "vitest";

const TEST_VERIFY_TOKEN = "test-verify-token";
const TEST_APP_SECRET = "test-app-secret";

const MANAGED_ENV_KEYS = [
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  // Dedupe must exercise the in-memory dev/test fallback deterministically.
  "DATABASE_URL",
  "DATABASE_URL_RO",
  "DB_HOST",
];

const savedEnv = new Map<string, string | undefined>();

function setEnv(vars: Record<string, string | undefined>) {
  for (const key of MANAGED_ENV_KEYS) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreEnv() {
  for (const key of MANAGED_ENV_KEYS) {
    const original = savedEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

type WhatsAppModules = {
  webhook: typeof import("./whatsapp/webhook");
  session: typeof import("./whatsapp/session");
  dedupe: typeof import("./whatsapp/dedupe");
  sender: typeof import("./whatsapp/sender");
};

/** Fresh module graph so ENV (computed at import time) reflects `vars`. */
async function freshModules(vars: Record<string, string | undefined>): Promise<WhatsAppModules> {
  setEnv(vars);
  vi.resetModules();
  const [webhook, session, dedupe, sender] = await Promise.all([
    import("./whatsapp/webhook"),
    import("./whatsapp/session"),
    import("./whatsapp/dedupe"),
    import("./whatsapp/sender"),
  ]);
  return { webhook, session, dedupe, sender };
}

async function startTestServer(modules: WhatsAppModules) {
  const app = express();
  app.get("/api/webhooks/whatsapp", modules.webhook.whatsappWebhookVerifyHandler);
  app.post(
    "/api/webhooks/whatsapp",
    express.raw({ type: "application/json" }),
    modules.webhook.whatsappWebhookPostHandler,
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

function stopServer(server: Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function sign(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

function inboundTextPayload(messageId: string, from: string, body: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "1555000111", phone_number_id: "PNID" },
              contacts: [{ profile: { name: "Ada" }, wa_id: from }],
              messages: [
                {
                  from,
                  id: messageId,
                  timestamp: "1700000000",
                  type: "text",
                  text: { body },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

afterEach(() => {
  restoreEnv();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/webhooks/whatsapp verification handshake", () => {
  it("accepts a matching verify token and echoes the challenge", async () => {
    const modules = await freshModules({ WHATSAPP_VERIFY_TOKEN: TEST_VERIFY_TOKEN });
    const { server, base } = await startTestServer(modules);
    try {
      const res = await fetch(
        `${base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${TEST_VERIFY_TOKEN}&hub.challenge=challenge-123`,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("challenge-123");
    } finally {
      await stopServer(server);
    }
  });

  it("denies a mismatched verify token with 403", async () => {
    const modules = await freshModules({ WHATSAPP_VERIFY_TOKEN: TEST_VERIFY_TOKEN });
    const { server, base } = await startTestServer(modules);
    try {
      const res = await fetch(
        `${base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-123`,
      );
      expect(res.status).toBe(403);
    } finally {
      await stopServer(server);
    }
  });

  it("denies the handshake when WHATSAPP_VERIFY_TOKEN is unset", async () => {
    const modules = await freshModules({});
    const { server, base } = await startTestServer(modules);
    try {
      const res = await fetch(
        `${base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${TEST_VERIFY_TOKEN}&hub.challenge=challenge-123`,
      );
      expect(res.status).toBe(403);
    } finally {
      await stopServer(server);
    }
  });
});

describe("POST /api/webhooks/whatsapp signature verification", () => {
  it("accepts a delivery with a valid X-Hub-Signature-256 (real HMAC)", async () => {
    const modules = await freshModules({ WHATSAPP_APP_SECRET: TEST_APP_SECRET });
    const { server, base } = await startTestServer(modules);
    try {
      const rawBody = JSON.stringify(inboundTextPayload("wamid.accept", "2348012345678", "menu"));
      const res = await fetch(`${base}/api/webhooks/whatsapp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": sign(rawBody, TEST_APP_SECRET),
        },
        body: rawBody,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ accepted: true });
    } finally {
      await stopServer(server);
    }
  });

  it("rejects a delivery with an invalid signature (401)", async () => {
    const modules = await freshModules({ WHATSAPP_APP_SECRET: TEST_APP_SECRET });
    const { server, base } = await startTestServer(modules);
    try {
      const rawBody = JSON.stringify(inboundTextPayload("wamid.reject", "2348012345678", "menu"));
      const res = await fetch(`${base}/api/webhooks/whatsapp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": sign(rawBody, "the-wrong-secret"),
        },
        body: rawBody,
      });
      expect(res.status).toBe(401);
    } finally {
      await stopServer(server);
    }
  });

  it("fails closed with 503 when WHATSAPP_APP_SECRET is unset", async () => {
    const modules = await freshModules({});
    const { server, base } = await startTestServer(modules);
    try {
      const rawBody = JSON.stringify(inboundTextPayload("wamid.precondition", "2348012345678", "menu"));
      const res = await fetch(`${base}/api/webhooks/whatsapp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": sign(rawBody, TEST_APP_SECRET),
        },
        body: rawBody,
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "whatsapp_webhook_not_configured" });
    } finally {
      await stopServer(server);
    }
  });
});

describe("post-ack processing: dedupe + session state machine", () => {
  it("processes a replayed message id exactly once", async () => {
    const modules = await freshModules({ WHATSAPP_APP_SECRET: TEST_APP_SECRET });
    const payload = inboundTextPayload("wamid.replay", "2348012345678", "menu");
    const first = await modules.webhook.processWhatsAppPayload(payload);
    expect(first.received).toBe(1);
    expect(first.processed).toBe(1);
    expect(first.duplicates).toBe(0);
    const second = await modules.webhook.processWhatsAppPayload(payload);
    expect(second.received).toBe(1);
    expect(second.processed).toBe(0);
    expect(second.duplicates).toBe(1);
  });

  it("drives main_menu → browse → cart on numbered replies", async () => {
    const modules = await freshModules({ WHATSAPP_APP_SECRET: TEST_APP_SECRET });
    const phone = "2348098765432";

    const menuResult = await modules.webhook.processWhatsAppPayload(
      inboundTextPayload("wamid.flow.1", phone, "menu"),
    );
    expect(menuResult.replies[0].reply).toContain("Welcome");
    let session = await modules.session.getWhatsAppSession(phone);
    expect(session?.state).toBe("main_menu");

    const browseResult = await modules.webhook.processWhatsAppPayload(
      inboundTextPayload("wamid.flow.2", phone, "1"),
    );
    expect(browseResult.replies[0].reply).toContain("selection");
    session = await modules.session.getWhatsAppSession(phone);
    expect(session?.state).toBe("browse");

    const cartResult = await modules.webhook.processWhatsAppPayload(
      inboundTextPayload("wamid.flow.3", phone, "1"),
    );
    expect(cartResult.replies[0].reply).toContain("Added");
    session = await modules.session.getWhatsAppSession(phone);
    expect(session?.state).toBe("cart");
    expect(session?.cart).toHaveLength(1);
  });
});

describe("sender fail-closed behaviour", () => {
  it("refuses to send without credentials and never touches the network", async () => {
    const modules = await freshModules({}); // no WHATSAPP_ACCESS_TOKEN / PHONE_NUMBER_ID
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await modules.sender.sendWhatsAppText("2348012345678", "hello");
    expect(result.sent).toBe(false);
    expect(result.wamid).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
