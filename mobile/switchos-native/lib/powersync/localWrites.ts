/**
 * Local write helpers for the PowerSync data layer — v1 whitelist scope.
 *
 * The upload bridge (server/_core/powersyncUpload.ts) is a STRICT whitelist:
 * v1 accepts ONLY `support_tickets` PUT. Writes to any other synced table
 * (or PATCH/DELETE anywhere) will be rejected with 400 and the SDK will
 * retry them forever — so this module is the ONLY sanctioned local-write
 * path, and it only queues support-case drafts.
 *
 * Validation mirrors the server zod schema exactly
 * (supportCaseDataSchema in powersyncUpload.ts):
 *   order_id    positive int | null | omitted
 *   type        order_issue | payment | driver | general | claim | refund
 *   subject     1..255 chars
 *   description 1..4000 chars
 *
 * How a queued case reconciles: the local row uses a client-generated
 * `pslocal-<uuid>` TEXT id and status 'pending_upload'. The upload entry's
 * id carries the same value; the server ignores client ids and derives the
 * real ticket idempotently from `powersync-upload-<entry.id>`. After the
 * write checkpoint for the upload arrives, PowerSync discards the local op
 * and the server-replicated row (numeric id, real ticket_number, status
 * 'open') replaces the placeholder. Until then, UIs can flag the local row
 * as "Sending…" via `isLocalPendingSupportCase`.
 *
 * NOTE: write-checkpoint plumbing for custom backends lands server-side
 * separately; if the placeholder lingers after a successful upload, a full
 * re-sync (disconnect + clear) converges the view. Documented in
 * docs/powersync/CLIENT_MOBILE.md.
 */

export const LOCAL_SUPPORT_CASE_ID_PREFIX = "pslocal-";

export const SUPPORT_CASE_TYPES = [
  "order_issue",
  "payment",
  "driver",
  "general",
  "claim",
  "refund",
] as const;

export type SupportCaseType = (typeof SUPPORT_CASE_TYPES)[number];

export interface SupportCaseDraft {
  orderId?: number | null;
  type: SupportCaseType;
  subject: string;
  description: string;
  /** Signed-in consumer id (users.id) — denormalized into the local row. */
  customerId: number;
}

export class SupportCaseDraftValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupportCaseDraftValidationError";
  }
}

/** Minimal SQL surface of AbstractPowerSyncDatabase used here. */
export interface SqlWriter {
  execute: (sql: string, params?: unknown[]) => Promise<unknown>;
}

/** Validates a draft against the server whitelist schema (fail fast). */
export function validateSupportCaseDraft(draft: SupportCaseDraft): void {
  if (draft.orderId !== undefined && draft.orderId !== null) {
    if (!Number.isSafeInteger(draft.orderId) || draft.orderId <= 0) {
      throw new SupportCaseDraftValidationError(
        "orderId must be a positive integer when present",
      );
    }
  }
  if (!SUPPORT_CASE_TYPES.includes(draft.type)) {
    throw new SupportCaseDraftValidationError(
      `type must be one of ${SUPPORT_CASE_TYPES.join(", ")}`,
    );
  }
  if (
    typeof draft.subject !== "string" ||
    draft.subject.length < 1 ||
    draft.subject.length > 255
  ) {
    throw new SupportCaseDraftValidationError("subject must be 1..255 chars");
  }
  if (
    typeof draft.description !== "string" ||
    draft.description.length < 1 ||
    draft.description.length > 4000
  ) {
    throw new SupportCaseDraftValidationError("description must be 1..4000 chars");
  }
  if (!Number.isSafeInteger(draft.customerId) || draft.customerId <= 0) {
    throw new SupportCaseDraftValidationError("customerId must be a positive integer");
  }
}

const ID_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Hermes-safe id (no crypto.randomUUID guarantee on RN). The prefix marks
 * the row as a local placeholder (see module header for the reconciliation
 * lifecycle).
 */
export function newLocalSupportCaseId(): string {
  const time = Date.now().toString(36);
  let random = "";
  for (let i = 0; i < 20; i += 1) {
    random += ID_ALPHABET.charAt(Math.floor(Math.random() * ID_ALPHABET.length));
  }
  return `${LOCAL_SUPPORT_CASE_ID_PREFIX}${time}-${random}`;
}

/**
 * Queues a validated support-case draft as a local support_tickets PUT.
 * The PowerSync CRUD trigger captures the INSERT into the FIFO upload queue;
 * the connector delivers it to POST /api/powersync/upload.
 * Returns the local row id.
 */
export async function queueSupportCaseDraft(
  db: SqlWriter,
  draft: SupportCaseDraft,
  now: Date = new Date(),
): Promise<string> {
  validateSupportCaseDraft(draft);
  const id = newLocalSupportCaseId();
  const isoNow = now.toISOString();

  await db.execute(
    `INSERT INTO support_tickets
       (id, ticket_number, customer_id, order_id, type, priority, status,
        subject, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      id, // placeholder ticket_number; server assigns the real one
      draft.customerId,
      draft.orderId ?? null,
      draft.type,
      "medium",
      "pending_upload", // client-only lifecycle marker (not a server enum value)
      draft.subject,
      draft.description,
      isoNow,
      isoNow,
    ],
  );
  return id;
}

/** True for locally queued placeholder rows not yet replaced by replication. */
export function isLocalPendingSupportCase(row: { id: string; status?: string | null }): boolean {
  return (
    row.id.startsWith(LOCAL_SUPPORT_CASE_ID_PREFIX) &&
    row.status === "pending_upload"
  );
}
