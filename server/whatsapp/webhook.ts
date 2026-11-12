import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response } from "express";

import { ENV } from "../_core/env";
import { tokensEqual } from "../_core/security";
import { claimWhatsAppInboundEvent } from "./dedupe";
import { renderMainMenu } from "./menu";
import { sendWhatsAppText } from "./sender";
import {
  getWhatsAppSession,
  handleWhatsAppInboundText,
  newWhatsAppSession,
  saveWhatsAppSession,
} from "./session";
import {
  isWhatsAppSuppressed,
  suppressWhatsAppNumber,
  unsuppressWhatsAppNumber,
} from "./suppression";

/**
 * WhatsApp Cloud API webhook consumer (P2 consumer flows).
 *
 * Contract (mounted in server/_core/index.ts at /api/webhooks/whatsapp):
 * - GET  — Meta subscription handshake: verifies hub.mode=subscribe and
 *   constant-time-compares hub.verify_token against WHATSAPP_VERIFY_TOKEN,
 *   then echoes hub.challenge (fail closed 403 when unset/mismatched).
 * - POST — HMAC-SHA256 raw-body signature check (X-Hub-Signature-256,
 *   WHATSAPP_APP_SECRET): 503 fail closed when the secret is unset, 401 on
 *   signature mismatch, otherwise an immediate 200 { accepted: true } ack
 *   and asynchronous processing via setImmediate. Meta retries any non-2xx,
 *   so a processing crash must never surface as 5xx.
 * - Dedupe is INSERT-first on public.consumer_processed_events (0072
 *   pattern) keyed by wamid; a replayed delivery is acked and skipped.
 * - Opt-out: an inbound STOP suppresses ALL outbound traffic to that number
 *   (suppression.ts; the sender double-checks before every send); START /
 *   UNSTOP re-enables it. The STOP confirmation is sent BEFORE the number
 *   is suppressed.
 */

const MAX_WA_MESSAGES_PER_PAYLOAD = 16;

interface WaInboundMessage {
  id: string;
  from: string;
  text: string;
}

/** Extract the (id, from, text) triples we handle from a Meta status payload. */
export function extractWaInboundMessages(body: unknown): WaInboundMessage[] {
  const messages: WaInboundMessage[] = [];
  const entries = (body as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes ?? [];
    for (const change of changes) {
      const value = (change as { value?: { messages?: unknown[] } })?.value;
      for (const message of value?.messages ?? []) {
        const m = message as {
          id?: string;
          from?: string;
          type?: string;
          text?: { body?: string };
        };
        if (m.type !== "text" || !m.id || !m.from) continue;
        messages.push({ id: m.id, from: m.from, text: m.text?.body ?? "" });
        if (messages.length >= MAX_WA_MESSAGES_PER_PAYLOAD) return messages;
      }
    }
  }
  return messages;
}

function verifyWaSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!ENV.whatsappAppSecret) return false;
  const expected =
    "sha256=" + createHmac("sha256", ENV.whatsappAppSecret).update(rawBody).digest("hex");
  const provided = signatureHeader ?? "";
  if (provided.length !== expected.length) {
    // Burn a comparison anyway so the early return does not leak length.
    timingSafeEqual(Buffer.from(expected), Buffer.from(expected));
    return false;
  }
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export interface WhatsAppProcessStats {
  received: number;
  processed: number;
  duplicates: number;
  replies: Array<{ to: string; reply: string }>;
}

const OPT_OUT_CONFIRMATION =
  "You have been unsubscribed from SwitchOS WhatsApp messages and will no longer hear from us here. Reply START anytime to resubscribe.";

const OPT_IN_CONFIRMATION = `Welcome back! You've been resubscribed to SwitchOS WhatsApp messages.`;

/** Process one acked payload: dedupe → opt-out handling → flow → reply. */
export async function processWhatsAppPayload(
  body: unknown,
): Promise<WhatsAppProcessStats> {
  const messages = extractWaInboundMessages(body);
  const stats: WhatsAppProcessStats = {
    received: messages.length,
    processed: 0,
    duplicates: 0,
    replies: [],
  };

  for (const message of messages) {
    try {
      const claim = await claimWhatsAppInboundEvent(message.id);
      if (claim === "duplicate") {
        stats.duplicates += 1; // replayed delivery: acked and skipped
        continue;
      }
      stats.processed += 1;
      const keyword = message.text.trim().toLowerCase();

      // STOP: confirm first (the sender would drop it once suppressed),
      // then suppress all future outbound to this number.
      if (keyword === "stop") {
        await sendWhatsAppText(message.from, OPT_OUT_CONFIRMATION);
        suppressWhatsAppNumber(message.from);
        stats.replies.push({ to: message.from, reply: OPT_OUT_CONFIRMATION });
        continue;
      }

      // START / UNSTOP while suppressed: re-enable and greet.
      if (
        (keyword === "start" || keyword === "unstop") &&
        isWhatsAppSuppressed(message.from)
      ) {
        unsuppressWhatsAppNumber(message.from);
        const session =
          (await getWhatsAppSession(message.from)) ??
          newWhatsAppSession(message.from);
        session.state = "main_menu";
        await saveWhatsAppSession(session);
        const reply = `${OPT_IN_CONFIRMATION}\n\n${renderMainMenu()}`;
        await sendWhatsAppText(message.from, reply);
        stats.replies.push({ to: message.from, reply });
        continue;
      }

      const session =
        (await getWhatsAppSession(message.from)) ??
        newWhatsAppSession(message.from);
      const { reply } = await handleWhatsAppInboundText(session, message.text, {
        messageId: message.id,
      });
      await saveWhatsAppSession(session);
      await sendWhatsAppText(message.from, reply);
      stats.replies.push({ to: message.from, reply });
    } catch (error) {
      console.error(
        `[whatsapp] inbound processing failed for ${message.from}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return stats;
}

/** GET /api/webhooks/whatsapp — Meta subscription verification handshake. */
export function whatsappWebhookVerifyHandler(req: Request, res: Response): void {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (!ENV.whatsappVerifyToken) {
    console.error("[whatsapp] GET handshake refused: WHATSAPP_VERIFY_TOKEN unset");
    res.status(403).json({ error: "whatsapp_webhook_not_configured" });
    return;
  }
  if (
    mode === "subscribe" &&
    typeof token === "string" &&
    tokensEqual(token, ENV.whatsappVerifyToken) &&
    typeof challenge === "string"
  ) {
    res.status(200).type("text/plain").send(challenge);
    return;
  }
  res.status(403).json({ error: "whatsapp_verify_failed" });
}

/**
 * POST /api/webhooks/whatsapp — signed delivery. Mounted with express.raw
 * (server/_core/index.ts), so req.body is the raw Buffer the HMAC covers.
 * Ack first, process via setImmediate; Meta retries on non-2xx.
 */
export function whatsappWebhookPostHandler(req: Request, res: Response): void {
  if (!ENV.whatsappAppSecret) {
    console.error("[whatsapp] POST refused: WHATSAPP_APP_SECRET unset");
    res.status(503).json({ error: "whatsapp_webhook_not_configured" });
    return;
  }
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : ((req as Request & { rawBody?: Buffer }).rawBody ??
      Buffer.from(JSON.stringify(req.body ?? {}), "utf8"));
  const signature = req.header("x-hub-signature-256");
  if (!verifyWaSignature(rawBody, signature)) {
    res.status(401).json({ error: "whatsapp_signature_invalid" });
    return;
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    // Validly signed but unparseable: ack and drop (never 5xx post-ack).
  }
  res.status(200).json({ accepted: true });
  if (parsed !== null) {
    setImmediate(() => {
      void processWhatsAppPayload(parsed);
    });
  }
}
