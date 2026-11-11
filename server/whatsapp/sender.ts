/**
 * sender.ts — WhatsApp Cloud API sender for the consumer channel.
 *
 * Delivers platform-computed conversational replies over the Meta Graph API
 * (v21.0), adapted from the whatsappCommerce waSender service to
 * DeliveryPlatform conventions:
 *   - credentials come from ENV only (WHATSAPP_ACCESS_TOKEN +
 *     WHATSAPP_PHONE_NUMBER_ID), never from tenant settings;
 *   - delivery goes through the shared resilientFetch client (per-host
 *     circuit breaker + per-attempt timeout);
 *   - FAIL CLOSED when unconfigured: the send is refused, logged, and
 *     reported as { sent: false } — it never throws and never touches the
 *     network without credentials.
 */

import { ENV } from "../_core/env";
import { resilientFetch } from "../_core/resilientFetch";

/** WhatsApp Cloud API text body limit is 4096; chunk earlier for safety. */
export const WA_TEXT_LIMIT = 4000;

const GRAPH_MESSAGES_BASE = "https://graph.facebook.com/v21.0";

export interface WhatsAppSendResult {
  sent: boolean;
  simulated: boolean;
  wamid: string | null;
  chunks: number;
}

/** True when both sender credentials are configured. */
export function isWhatsAppSenderConfigured(): boolean {
  return Boolean(ENV.whatsappAccessToken && ENV.whatsappPhoneNumberId);
}

let unconfiguredWarned = false;
function warnUnconfigured(): void {
  if (unconfiguredWarned) return;
  unconfiguredWarned = true;
  console.warn(
    "[whatsapp-sender] WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID unset — " +
      "outbound WhatsApp sends are disabled (fail closed, nothing is sent)",
  );
}

/** Normalize to the digits-only format the Cloud API expects for `to`. */
export function normalizeWhatsAppPhone(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

/**
 * Split a message into chunks of at most `limit` characters, preferring to
 * break on newlines/spaces so chunks stay readable.
 */
export function chunkWhatsAppText(body: string, limit: number = WA_TEXT_LIMIT): string[] {
  if (body.length <= limit) return [body];
  const chunks: string[] = [];
  let remaining = body;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = remaining.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Send a free-text WhatsApp message. Never throws: a missing configuration
 * or a failed Graph API call is logged and reported in the result so the
 * post-ack webhook path can continue (Meta was already acked).
 */
export async function sendWhatsAppText(
  toPhone: string,
  body: string,
): Promise<WhatsAppSendResult> {
  const to = normalizeWhatsAppPhone(toPhone);
  const chunks = chunkWhatsAppText(body);

  if (!isWhatsAppSenderConfigured()) {
    warnUnconfigured();
    return { sent: false, simulated: false, wamid: null, chunks: chunks.length };
  }
  if (!to || !body.trim()) {
    console.warn("[whatsapp-sender] empty recipient or body — send refused");
    return { sent: false, simulated: false, wamid: null, chunks: chunks.length };
  }

  let lastWamid: string | null = null;
  for (const chunk of chunks) {
    const url = `${GRAPH_MESSAGES_BASE}/${ENV.whatsappPhoneNumberId}/messages`;
    try {
      const res = await resilientFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ENV.whatsappAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { preview_url: true, body: chunk },
        }),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.error(`[whatsapp-sender] Graph API error ${res.status}: ${errBody.slice(0, 500)}`);
        return { sent: false, simulated: false, wamid: lastWamid, chunks: chunks.length };
      }
      const data = (await res.json().catch(() => ({}))) as {
        messages?: Array<{ id?: string }>;
      };
      lastWamid = data?.messages?.[0]?.id ?? lastWamid;
    } catch (error) {
      console.error(
        "[whatsapp-sender] send failed:",
        error instanceof Error ? error.message : error,
      );
      return { sent: false, simulated: false, wamid: lastWamid, chunks: chunks.length };
    }
  }

  return { sent: true, simulated: false, wamid: lastWamid, chunks: chunks.length };
}
