/**
 * WhatsApp opt-out suppression (STOP/START) for the consumer channel.
 *
 * Semantics follow the waSuppressionList pattern in the sister repo
 * munisp/whatsappCommerce: an inbound STOP suppresses ALL outbound traffic
 * to that number (after a single confirmation message), and START/UNSTOP
 * re-enables it. sender.ts checks isWhatsAppSuppressed before every send.
 *
 * LIMITATION (documented, deliberate): this list is process-local
 * in-memory. DeliveryPlatform has no wa_suppression_list-equivalent table on
 * main (whatsappCommerce backs its list with Postgres + Redis; neither the
 * table nor a Redis client exists here), so a restart or second server
 * instance forgets opt-outs. Meta's own Cloud API blocking still applies at
 * the account level; durable suppression is a follow-up wave item alongside
 * durable sessions. Fails safe for the sender (check-before-send), and the
 * webhook re-confirms STOP idempotently.
 */

const suppressedNumbers = new Set<string>();

function normalizeNumber(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

export function suppressWhatsAppNumber(raw: string): void {
  const number = normalizeNumber(raw);
  if (number) suppressedNumbers.add(number);
}

/** Returns true when the number was suppressed and is now re-enabled. */
export function unsuppressWhatsAppNumber(raw: string): boolean {
  return suppressedNumbers.delete(normalizeNumber(raw));
}

export function isWhatsAppSuppressed(raw: string): boolean {
  return suppressedNumbers.has(normalizeNumber(raw));
}

/** Clear the suppression list (test support only). */
export function __clearWhatsAppSuppressionForTests(): void {
  suppressedNumbers.clear();
}
