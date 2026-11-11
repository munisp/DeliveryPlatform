/**
 * dedupe.ts — Inbound dedupe ledger for the WhatsApp webhook.
 *
 * Meta retries webhook deliveries until it gets a 200, so the same message
 * can arrive more than once. The guarantee is an INSERT-FIRST claim against
 * the shared consumer idempotency ledger public.consumer_processed_events
 * (migration 0072): the Meta wamid is the event_id and the primary key
 * (consumer_name, topic, event_id) makes a retry/concurrent delivery collide
 * (ON CONFLICT DO NOTHING → zero rows returned) so it is processed exactly
 * once. The table is used as-is; this module never alters it.
 *
 * Failure policy (mirrors the whatsappCommerce webhookDedupe contract):
 *   - production: FAIL CLOSED — the claim throws, post-ack processing logs
 *     the failure and Meta retries later (a blind dedupe ledger must not
 *     silently reprocess a message);
 *   - development/test without the table or without a database: in-memory
 *     Set fallback with a loud warning so local dev and unit tests work.
 */

import { DatabaseUnavailableError, getPool } from "../db";
import { ENV } from "../_core/env";

const CONSUMER_NAME = "whatsapp-webhook";
const TOPIC = "whatsapp.inbound";

export type WhatsAppClaimResult = "claimed" | "duplicate";

/** Dev/test-only fallback when the ledger is unreachable. */
const memoryLedger = new Set<string>();
let memoryFallbackWarned = false;

/** Postgres "undefined_table" SQLSTATE. */
function isMissingTableError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === "42P01" || /relation .* does not exist/i.test(e?.message ?? "");
}

function isLedgerUnavailableError(err: unknown): boolean {
  return err instanceof DatabaseUnavailableError || isMissingTableError(err);
}

function warnMemoryFallback(): void {
  if (memoryFallbackWarned) return;
  memoryFallbackWarned = true;
  console.warn(
    "[whatsapp-dedupe] consumer_processed_events ledger unavailable — using " +
      "in-memory dedupe fallback (dev/test only; production fails closed)",
  );
}

/**
 * Claim an inbound WhatsApp message for processing. Returns "claimed" when
 * this caller won the insert-first race, "duplicate" when the message id was
 * already claimed. An empty message id cannot be ledgered — it is logged and
 * treated as claimed (never silently dropped).
 */
export async function claimWhatsAppInboundEvent(
  messageId: string,
  detail?: Record<string, unknown>,
): Promise<WhatsAppClaimResult> {
  const id = messageId.trim();
  if (!id) {
    console.warn("[whatsapp-dedupe] inbound message without an id — processed without dedupe");
    return "claimed";
  }
  try {
    const pool = await getPool();
    const result = await pool.query(
      `INSERT INTO public.consumer_processed_events (consumer_name, topic, event_id, result_json)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (consumer_name, topic, event_id) DO NOTHING
       RETURNING event_id`,
      [CONSUMER_NAME, TOPIC, id, detail === undefined ? null : JSON.stringify(detail)],
    );
    return result.rows.length > 0 ? "claimed" : "duplicate";
  } catch (err) {
    if (!ENV.isProduction && isLedgerUnavailableError(err)) {
      // Dev/test fallback: in-memory ledger. Loud, once per process.
      warnMemoryFallback();
      if (memoryLedger.has(id)) return "duplicate";
      memoryLedger.add(id);
      return "claimed";
    }
    // Production (or a real DB error): fail closed — post-ack processing
    // aborts and Meta retries instead of us silently reprocessing.
    throw err;
  }
}

/** Test helper: reset the in-memory fallback ledger. */
export function __resetWhatsAppDedupeForTests(): void {
  memoryLedger.clear();
  memoryFallbackWarned = false;
}
