/**
 * webhook.ts — Meta WhatsApp Cloud API webhook ingress (consumer channel).
 *
 * Flow (adapted from the whatsappCommerce webhook, matched to
 * DeliveryPlatform conventions):
 *   GET  /api/webhooks/whatsapp — Meta verification handshake: echoes
 *        hub.challenge when hub.mode=subscribe and hub.verify_token matches
 *        WHATSAPP_VERIFY_TOKEN (constant-time compare), 403 otherwise.
 *   POST /api/webhooks/whatsapp — verifies X-Hub-Signature-256 as
 *        HMAC-SHA256 over the RAW request body with timingSafeEqual
 *        (401 on mismatch), answers 503 whatsapp_webhook_not_configured when
 *        WHATSAPP_APP_SECRET is unset (fail closed — never crash, never
 *        accept unverifiable traffic), then acks 200 IMMEDIATELY and defers
 *        dedupe + session + reply work to a setImmediate post-ack task so
 *        Meta stops retrying while we process.
 *
 * The route is mounted with express.raw({ type: "application/json" }) BEFORE
 * the global JSON parser (see server/_core/index.ts) so req.body is the
 * exact Buffer the HMAC was computed over.
 *
 * Importing this module never crashes when the WHATSAPP_* vars are unset —
 * all configuration checks run per request, not at import time.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type express from "express";

import { ENV } from "../_core/env";
import { tokensEqual } from "../_core/security";
import { claimWhatsAppInboundEvent } from "./dedupe";
import {
  getWhatsAppSession,
  handleWhatsAppInboundText,
  newWhatsAppSession,
  saveWhatsAppSession,
} from "./session";
import { sendWhatsAppText } from "./sender";

/** Meta verification handshake (GET). */
export function whatsappWebhookVerifyHandler(
  req: express.Request,
  res: express.Response,
): void {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const expected = ENV.whatsappVerifyToken;
  if (
    expected &&
    mode === "subscribe" &&
    typeof token === "string" &&
    tokensEqual(token, expected)
  ) {
    res
      .status(200)
      .type("text/plain")
      .send(typeof challenge === "string" ? challenge : "");
    return;
  }
  if (!expected) {
    console.warn("[WhatsApp] WHATSAPP_VERIFY_TOKEN unset — verification handshake refused");
  }
  res.status(403).json({ error: "whatsapp_verify_token_mismatch" });
}

/**
 * Verify the X-Hub-Signature-256 header ("sha256=<hex>") against the raw
 * body using HMAC-SHA256 + timingSafeEqual. Returns false when the app
 * secret is unset (fail closed).
 */
export function verifyWhatsAppSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  const secret = ENV.whatsappAppSecret;
  if (!secret) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec((signatureHeader ?? "").trim());
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(match[1], "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

let appSecretWarned = false;

/** Webhook delivery (POST): verify → immediate 200 ack → post-ack work. */
export function whatsappWebhookPostHandler(
  req: express.Request,
  res: express.Response,
): void {
  if (!ENV.whatsappAppSecret) {
    // Fail closed: without the app secret no delivery can be authenticated.
    if (!appSecretWarned) {
      appSecretWarned = true;
      console.warn(
        "[WhatsApp] WHATSAPP_APP_SECRET unset — webhook deliveries refused (503)",
      );
    }
    res.status(503).json({ error: "whatsapp_webhook_not_configured" });
    return;
  }
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifyWhatsAppSignature(rawBody, req.header("X-Hub-Signature-256"))) {
    res.status(401).json({ error: "whatsapp_signature_invalid" });
    return;
  }

  // Immediate ack — Meta retries any non-200, so the response must not wait
  // on dedupe/session/sender work.
  res.status(200).json({ accepted: true });

  let parsed: unknown = null;
  try {
    parsed = rawBody.length ? JSON.parse(rawBody.toString("utf8")) : null;
  } catch {
    parsed = null;
  }
  const payload = parsed;
  setImmediate(() => {
    void processWhatsAppPayload(payload).catch((error) => {
      console.error(
        "[WhatsApp] post-ack processing failed:",
        error instanceof Error ? error.message : error,
      );
    });
  });
}

export interface WhatsAppInboundTextMessage {
  /** Meta wamid — the dedupe key. */
  id: string;
  /** Sender phone (digits). */
  from: string;
  text: string;
}

/** Extract inbound text messages from a Meta webhook payload. */
export function extractInboundTextMessages(payload: unknown): WhatsAppInboundTextMessage[] {
  const messages: WhatsAppInboundTextMessage[] = [];
  if (!payload || typeof payload !== "object") return messages;
  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return messages;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: unknown })?.value;
      const list = (value as { messages?: unknown })?.messages;
      if (!Array.isArray(list)) continue;
      for (const message of list) {
        const m = message as {
          id?: unknown;
          from?: unknown;
          type?: unknown;
          text?: { body?: unknown };
        };
        if (m?.type !== "text") continue;
        const text = typeof m.text?.body === "string" ? m.text.body : "";
        messages.push({
          id: typeof m.id === "string" ? m.id : "",
          from: typeof m.from === "string" ? m.from : "",
          text,
        });
      }
    }
  }
  return messages;
}

export interface WhatsAppProcessingSummary {
  received: number;
  processed: number;
  duplicates: number;
  replies: Array<{ to: string; sent: boolean; reply: string }>;
}

/**
 * Post-ack processing: dedupe each inbound text message on its wamid, drive
 * the session state machine, and send the reply (fail-closed sender). Status
 * receipts and non-text messages are ignored. Exported for direct testing.
 */
export async function processWhatsAppPayload(
  payload: unknown,
): Promise<WhatsAppProcessingSummary> {
  const messages = extractInboundTextMessages(payload);
  const summary: WhatsAppProcessingSummary = {
    received: messages.length,
    processed: 0,
    duplicates: 0,
    replies: [],
  };
  for (const message of messages) {
    const claim = await claimWhatsAppInboundEvent(message.id, {
      from: message.from,
    });
    if (claim === "duplicate") {
      summary.duplicates += 1;
      continue;
    }
    const session =
      (await getWhatsAppSession(message.from)) ?? newWhatsAppSession(message.from);
    const { reply } = handleWhatsAppInboundText(session, message.text);
    await saveWhatsAppSession(session);
    const send = await sendWhatsAppText(message.from, reply);
    summary.replies.push({ to: message.from, sent: send.sent, reply });
    summary.processed += 1;
  }
  return summary;
}
