import { ENV } from "../_core/env";
import { resilientFetch } from "../_core/resilientFetch";
import { isWhatsAppSuppressed } from "./suppression";

/** WhatsApp Cloud API text body limit is 4096; chunk earlier for safety. */
export const WA_TEXT_LIMIT = 4000;

const GRAPH_MESSAGES_BASE = "https://graph.facebook.com/v21.0";

export interface WhatsAppSendResult {
  sent: boolean;
  simulated: boolean;
  wamid: string | null;
  chunks: number;
  /** True when the send was refused because the number opted out (STOP). */
  suppressed?: boolean;
}

/** Normalize to digits only, as the Cloud API expects. */
export function normalizeWhatsAppPhone(raw: string): string {
  return raw.replace(/[^\d+]/g, "").replace(/^\D+/, "");
}

/** True when the access token + phone number id are both configured. */
export function isWhatsAppSenderConfigured(): boolean {
  return Boolean(ENV.whatsappAccessToken && ENV.whatsappPhoneNumberId);
}

/** Split a long body into whitespace-aware chunks (hard-split fallback). */
export function chunkWhatsAppText(body: string, limit = WA_TEXT_LIMIT): string[] {
  if (body.length <= limit) return [body];
  const chunks: string[] = [];
  let remaining = body;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf(" ", limit);
    if (cut < limit / 2) cut = limit; // no convenient whitespace — hard split
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

let warnedUnconfigured = false;

function warnUnconfigured(): void {
  if (warnedUnconfigured) return;
  warnedUnconfigured = true;
  console.error(
    "[whatsapp-sender] WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID unset; outbound suppressed (fail closed)",
  );
}

/**
 * Send a WhatsApp text message. NEVER throws: fail-closed returns
 * { sent: false } and logs, so webhook processing must not 5xx because a
 * reply could not be delivered. Numbers that replied STOP are refused
 * before any network call (suppression.ts; checked on every send).
 */
export async function sendWhatsAppText(
  toPhone: string,
  body: string,
): Promise<WhatsAppSendResult> {
  const to = normalizeWhatsAppPhone(toPhone);
  const chunks = chunkWhatsAppText(body);

  // Opt-out suppression is checked before EVERY send (STOP/START contract).
  if (isWhatsAppSuppressed(to)) {
    console.warn(`[whatsapp-sender] send to ${to} refused: number opted out (STOP)`);
    return { sent: false, simulated: false, wamid: null, chunks: 0, suppressed: true };
  }

  if (!isWhatsAppSenderConfigured()) {
    warnUnconfigured();
    return { sent: false, simulated: true, wamid: null, chunks: chunks.length };
  }

  let wamid: string | null = null;
  try {
    for (let i = 0; i < chunks.length; i += 1) {
      const response = await resilientFetch(
        `${GRAPH_MESSAGES_BASE}/${ENV.whatsappPhoneNumberId}/messages`,
        {
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
            text: { preview_url: false, body: chunks[i] },
          }),
          timeoutMs: 10_000,
        },
      );
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        console.error(
          `[whatsapp-sender] send failed: HTTP ${response.status} ${detail.slice(0, 200)}`,
        );
        return { sent: false, simulated: false, wamid, chunks: i };
      }
      const json = (await response.json()) as { messages?: Array<{ id?: string }> };
      if (i === 0) wamid = json.messages?.[0]?.id ?? null;
    }
    return { sent: true, simulated: false, wamid, chunks: chunks.length };
  } catch (error) {
    console.error(
      `[whatsapp-sender] send error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { sent: false, simulated: false, wamid, chunks: 0 };
  }
}
