/**
 * PowerSync upload bridge — POST /api/powersync/upload.
 *
 * PowerSync never writes to Postgres: client SQLite mutations are queued in
 * the SDK's persistent FIFO CRUD queue and delivered to this endpoint by the
 * connector's uploadData(). Each entry is {op: PUT|PATCH|DELETE, table, id,
 * data}; entries must be applied in order, synchronously, and IDEMPOTENTLY —
 * if this endpoint returns non-2xx the SDK retries with backoff indefinitely.
 *
 * Dispatch is a STRICT WHITELIST: an entry only executes if its (table, op)
 * pair is registered below with a handler that calls an existing server
 * data-access function. Unknown table/op -> 400 (never silently applied).
 * Any handler failure -> non-2xx so the client retry loop redelivers.
 *
 * Idempotency: handlers derive their idempotency key from the queue entry id
 * (`powersync-upload-<entry.id>`), so SDK redelivery replays collide on the
 * underlying uniqueness constraints instead of duplicating writes.
 *
 * v1 whitelist (one fully-worked example):
 *   support_tickets / PUT -> openConsumerSupportCase (consumerQueries.ts) —
 *   idempotent by construction: the ticket number is derived from
 *   (consumer id, idempotency key) with ON CONFLICT DO NOTHING.
 *
 * HOW TO ADD AN ENTRY:
 *   1. Pick the existing data-access function that owns the write path for
 *      the table (never write SQL here). It must be idempotent given a
 *      deterministic key derived from the entry id — if it is not, fix the
 *      data-access function first (upsert / ON CONFLICT semantics).
 *   2. Validate + narrow `entry.data` with zod; ignore client-supplied fields
 *      that the server must own (ids, foreign keys to the caller, status).
 *   3. Register the handler under the (table, op) key and add a static pin to
 *      tests/powersync-integration.test.ts.
 *   Candidate next entries (need clean idempotent functions first): loyalty
 *   opt-in prefs, support-case message append.
 */
import type express from "express";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { openConsumerSupportCase } from "./consumerQueries";
import { isPowerSyncConfigured } from "./powersyncToken";
import type { SessionUser } from "./trpc";

type AppRequest = express.Request & { user?: SessionUser | null };

const crudEntrySchema = z.object({
  id: z.union([z.string().min(1).max(128), z.number().int().nonnegative()]),
  op: z.enum(["PUT", "PATCH", "DELETE"]),
  table: z.string().min(1).max(128),
  data: z.record(z.string(), z.unknown()).optional(),
});

const uploadEnvelopeSchema = z.object({
  entries: z.array(crudEntrySchema).min(1).max(100),
});

export type PowerSyncCrudEntry = z.infer<typeof crudEntrySchema>;

type UploadHandler = (userId: number, entry: PowerSyncCrudEntry) => Promise<void>;

const supportCaseDataSchema = z.object({
  order_id: z.number().int().positive().nullable().optional(),
  type: z.enum(["order_issue", "payment", "driver", "general", "claim", "refund"]),
  subject: z.string().min(1).max(255),
  description: z.string().min(1).max(4000),
});

function entryIdempotencyKey(entry: PowerSyncCrudEntry): string {
  return `powersync-upload-${entry.id}`;
}

/**
 * The whitelist. Keyed `<table>` then `<op>`; anything absent is a 400.
 * KEEP THIS MAP EXPLICIT — it is the entire attack surface of the endpoint.
 */
export const POWERSYNC_UPLOAD_WHITELIST: Record<
  string,
  Partial<Record<"PUT" | "PATCH" | "DELETE", UploadHandler>>
> = {
  support_tickets: {
    PUT: async (userId, entry) => {
      const data = supportCaseDataSchema.parse(entry.data ?? {});
      await openConsumerSupportCase({
        consumerUserId: userId,
        orderId: data.order_id ?? null,
        type: data.type,
        subject: data.subject,
        description: data.description,
        idempotencyKey: entryIdempotencyKey(entry),
      });
    },
  },
};

/** Exported for tests: does the whitelist allow this (table, op) pair? */
export function isPowerSyncUploadAllowed(table: string, op: string): boolean {
  return Boolean(
    POWERSYNC_UPLOAD_WHITELIST[table]?.[op as "PUT" | "PATCH" | "DELETE"],
  );
}

function statusForHandlerError(error: unknown): number {
  if (error instanceof z.ZodError) return 422;
  if (error instanceof TRPCError) {
    // Client-correctable domain errors (bad type, order not owned): 422 so a
    // well-behaved uploader can discard-and-continue; the SDK still retries,
    // which is safe because these handlers are idempotent.
    if (error.code === "BAD_REQUEST" || error.code === "NOT_FOUND") return 422;
  }
  return 500;
}

/**
 * POST /api/powersync/upload — session-authed (mounted after the session
 * middleware), rate-limited 120/min/IP at the mount site. Fail-closed: 503
 * `powersync_not_configured` when token issuance is not configured (an upload
 * bridge without a token path is a misconfigured deployment).
 */
export async function powerSyncUploadHandler(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const user = (req as AppRequest).user;
  if (!user) {
    res.status(401).json({ error: "authentication_required" });
    return;
  }
  if (!isPowerSyncConfigured()) {
    res.status(503).json({ error: "powersync_not_configured" });
    return;
  }

  const parsed = uploadEnvelopeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "powersync_upload_envelope_invalid" });
    return;
  }

  // FIFO: entries apply in queue order; the first failure stops the batch so
  // ordering is preserved (the SDK redelivers from the failed entry).
  for (const entry of parsed.data.entries) {
    const handler =
      POWERSYNC_UPLOAD_WHITELIST[entry.table]?.[entry.op];
    if (!handler) {
      res.status(400).json({
        error: "powersync_upload_not_allowed",
        table: entry.table,
        op: entry.op,
      });
      return;
    }
    try {
      await handler(user.id, entry);
    } catch (error) {
      console.error("[SwitchOS] PowerSync upload entry failed", {
        table: entry.table,
        op: entry.op,
        error,
      });
      res.status(statusForHandlerError(error)).json({
        error: "powersync_upload_entry_failed",
        table: entry.table,
        op: entry.op,
      });
      return;
    }
  }

  res.status(200).json({ applied: parsed.data.entries.length });
}
