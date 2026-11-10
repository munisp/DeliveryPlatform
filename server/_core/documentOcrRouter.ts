/**
 * documentOcr tRPC router — MiniCPM-OCR 1.0 document field extraction.
 *
 *   - documentOcr.extract        (authenticated) → drivers/renters extract
 *     fields from their OWN uploaded document image (KYC capture, delivery
 *     receipts, proof-of-delivery photos).
 *   - documentOcr.extractForCase (operator, "operate" tier — same policy key
 *     the verification router uses for KYC case actions) → extraction in the
 *     context of a verification case review; audit-logged via
 *     recordOperationalEvent like the rental condition photo endpoint.
 *
 * The router only validates input shape and audits; all Ollama interaction,
 * fail-closed semantics, and confidence routing live in
 * server/_core/documentOcr.ts. Extracted field VALUES are never written to
 * the operational event stream (PII minimization) — only metadata.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  DocumentOcrError,
  extractDocumentFields,
  OCR_FIELD_NAME_PATTERN,
  OCR_IMAGE_MAX_BYTES,
  OCR_MAX_FIELDS,
} from "./documentOcr";
import { recordOperationalEvent } from "./operationalEvents";
import {
  authenticatedProcedure,
  operatorMutationProcedure,
  router,
} from "./trpc";

const fieldNameSchema = z
  .string()
  .trim()
  .regex(OCR_FIELD_NAME_PATTERN, "field names must match /^[a-zA-Z][a-zA-Z0-9_ ]{0,60}$/");

const contentTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp"]);

// Decoded bytes are capped at OCR_IMAGE_MAX_BYTES inside the service; the
// base64 envelope cap below (4/3 expansion + padding) rejects oversize
// payloads before decoding.
const imageBase64Schema = z
  .string()
  .min(4)
  .max(Math.ceil(OCR_IMAGE_MAX_BYTES / 3) * 4 + 4);

const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);

const extractInputSchema = z.object({
  imageBase64: imageBase64Schema,
  contentType: contentTypeSchema,
  fields: z.array(fieldNameSchema).min(1).max(OCR_MAX_FIELDS),
  documentHint: z.string().trim().min(1).max(200).optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
});

function toTrpcError(error: unknown): never {
  if (error instanceof DocumentOcrError) {
    // Fail-closed codes map to honest HTTP-level semantics; no fabrication.
    const code =
      error.code === "ocr_not_configured" || error.code === "ocr_backend_unavailable"
        ? ("PRECONDITION_FAILED" as const)
        : error.code === "ocr_backend_error"
          ? ("BAD_GATEWAY" as const)
          : ("BAD_REQUEST" as const);
    throw new TRPCError({ code, message: error.code });
  }
  throw error;
}

async function auditExtraction(input: {
  user: { id: number; role?: string | null; tenantId?: string | null } | null;
  route: string;
  outcome: "success" | "failure";
  payload: Record<string, unknown>;
}) {
  await recordOperationalEvent({
    eventType: "ai.document_ocr.extracted",
    actorId: input.user ? `${input.user.id}` : null,
    actorRole: input.user?.role ?? null,
    tenantId: input.user?.tenantId ?? null,
    route: input.route,
    outcome: input.outcome,
    payload: input.payload,
  }).catch(() => {});
}

export const documentOcrRouter = router({
  extract: authenticatedProcedure
    .input(extractInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await extractDocumentFields(input);
        await auditExtraction({
          user: ctx.user,
          route: "documentOcr.extract",
          outcome: "success",
          payload: {
            fieldCount: input.fields.length,
            documentHint: result.documentHint,
            idempotencyKey: result.idempotencyKey,
            jevEnabled: result.jev.enabled,
            model: result.model,
          },
        });
        return result;
      } catch (error) {
        await auditExtraction({
          user: ctx.user,
          route: "documentOcr.extract",
          outcome: "failure",
          payload: {
            fieldCount: input.fields.length,
            errorCode: error instanceof DocumentOcrError ? error.code : "unexpected",
          },
        });
        toTrpcError(error);
      }
    }),

  extractForCase: operatorMutationProcedure("operate")
    .input(
      extractInputSchema.extend({
        caseId: z.string().uuid(),
        imageObjectKey: z.string().trim().min(1).max(512),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await extractDocumentFields(input);
        await auditExtraction({
          user: ctx.user,
          route: "documentOcr.extractForCase",
          outcome: "success",
          payload: {
            caseId: input.caseId,
            imageObjectKey: input.imageObjectKey,
            fieldCount: input.fields.length,
            documentHint: result.documentHint,
            jevEnabled: result.jev.enabled,
            model: result.model,
          },
        });
        return { caseId: input.caseId, imageObjectKey: input.imageObjectKey, ...result };
      } catch (error) {
        await auditExtraction({
          user: ctx.user,
          route: "documentOcr.extractForCase",
          outcome: "failure",
          payload: {
            caseId: input.caseId,
            imageObjectKey: input.imageObjectKey,
            fieldCount: input.fields.length,
            errorCode: error instanceof DocumentOcrError ? error.code : "unexpected",
          },
        });
        toTrpcError(error);
      }
    }),
});
