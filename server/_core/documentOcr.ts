/**
 * MiniCPM-OCR 1.0 document field extraction, served through the platform's
 * existing Ollama runtime.
 *
 * Reuse note (wave research): the LongCat speech-runtime already talks to
 * Ollama via the shared `OLLAMA_URL` environment variable, surfaced as
 * `ENV.ollamaUrl` in server/_core/env.ts and consumed by
 * server/_core/longcatVoice.ts (`${ENV.ollamaUrl}/api/generate`). This module
 * deliberately reuses the SAME `OLLAMA_URL` variable as its default endpoint
 * instead of inventing a parallel config namespace; `MINICPM_OCR_OLLAMA_URL`
 * exists only as an override for deployments that pin the vision model to a
 * dedicated Ollama replica (GPU node) separate from the chat model.
 *
 * Fail-closed contract (KYC evidence must never be fabricated):
 *   - no Ollama URL configured          -> throws ocr_not_configured
 *   - network error / abort on timeout  -> throws ocr_backend_unavailable
 *   - non-200 from Ollama               -> throws ocr_backend_error (with status)
 *   - image too large / wrong type      -> throws ocr_image_too_large /
 *                                          ocr_unsupported_content_type
 *   - unparseable model output          -> throws ocr_response_unparseable
 * There is NO silent fallback that fabricates extracted fields.
 *
 * Confidence honesty: MiniCPM-OCR 1.0 emits no per-field confidence. The only
 * confidence signal is the optional companion judge pass (MiniCPM-OCR Jev),
 * gated behind MINICPM_OCR_JEV_ENABLED=true. When the judge is disabled,
 * `confidence` is null and `needsReview` is false — callers must not treat
 * the absence of a score as evidence of correctness.
 */

/** Same decoded-byte ceiling as the rental condition photo endpoint. */
export const OCR_IMAGE_MAX_BYTES = 6_000_000;

export const OCR_MAX_FIELDS = 32;

/** Field names the KIE prompt will accept (validated before prompt build). */
export const OCR_FIELD_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_ ]{0,60}$/;

const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

// Strict RFC 4648 alphabet with padding only at the end; kept free of nested
// quantifiers so multi-megabyte payloads validate in linear time (mirrors the
// rental condition photo decoder).
const STRICT_BASE64_PATTERN = /^[A-Za-z0-9+/]*(?:=|==)?$/;

export class DocumentOcrError extends Error {
  readonly code: string;
  readonly httpStatus?: number;

  constructor(code: string, message: string, httpStatus?: number) {
    super(message);
    this.name = "DocumentOcrError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export type DocumentOcrConfig = {
  /** Ollama base URL without a trailing slash. Empty string = unconfigured. */
  ollamaUrl: string;
  model: string;
  timeoutMs: number;
  jevEnabled: boolean;
  jevModel: string;
  reviewThreshold: number;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function parseClampedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, minimum, maximum);
}

function parseClampedUnitInterval(
  raw: string | undefined,
  fallback: number,
) {
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number.parseFloat(raw.trim());
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, 0, 1);
}

/**
 * Resolve configuration at CALL time (not import time) so tests and runtime
 * reloads see current env. The URL falls back to the speech-runtime's
 * OLLAMA_URL — but reads process.env directly rather than ENV.ollamaUrl,
 * because ENV.ollamaUrl silently defaults to http://127.0.0.1:11434 and this
 * surface must fail closed with ocr_not_configured when nothing was set.
 */
export function resolveDocumentOcrConfig(
  env: NodeJS.ProcessEnv = process.env,
): DocumentOcrConfig {
  const explicit = env.MINICPM_OCR_OLLAMA_URL?.trim() ?? "";
  // Reuse of the existing speech-runtime variable is intentional; see header.
  const shared = env.OLLAMA_URL?.trim() ?? "";
  const ollamaUrl = (explicit || shared).replace(/\/+$/, "");
  return {
    ollamaUrl,
    model: (env.MINICPM_OCR_MODEL ?? "minicpm-ocr:1.0").trim() || "minicpm-ocr:1.0",
    timeoutMs: parseClampedInteger(env.MINICPM_OCR_TIMEOUT_MS, 60_000, 5_000, 300_000),
    jevEnabled: (env.MINICPM_OCR_JEV_ENABLED ?? "").trim().toLowerCase() === "true",
    jevModel: (env.MINICPM_OCR_JEV_MODEL ?? "minicpm-ocr-jev:2b").trim() || "minicpm-ocr-jev:2b",
    reviewThreshold: parseClampedUnitInterval(env.MINICPM_OCR_REVIEW_THRESHOLD, 0.7),
  };
}

export type ExtractDocumentFieldsInput = {
  imageBase64: string;
  contentType: string;
  fields: string[];
  documentHint?: string;
  idempotencyKey?: string;
};

export type DocumentFieldResult = {
  /** Normalized value; null when the model reports the field missing. */
  value: string | null;
  /** Verbatim model output for the field (before "###" -> null mapping). */
  raw: string | null;
  /** Jev judge score 0..1, or null when the judge is disabled/unavailable. */
  confidence: number | null;
  /** True only when a real judge score exists AND is below the threshold. */
  needsReview: boolean;
};

export type ExtractDocumentFieldsResult = {
  model: string;
  documentHint: string | null;
  idempotencyKey: string | null;
  jev: { enabled: boolean; model: string | null };
  fields: Record<string, DocumentFieldResult>;
};

/** MiniCPM-OCR reports "###" for fields it cannot locate on the document. */
const MISSING_FIELD_SENTINEL = "###";

export function validateFieldNames(fields: string[]): string[] {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new DocumentOcrError("ocr_no_fields", "At least one field name is required.");
  }
  if (fields.length > OCR_MAX_FIELDS) {
    throw new DocumentOcrError(
      "ocr_too_many_fields",
      `At most ${OCR_MAX_FIELDS} fields per extraction (got ${fields.length}).`,
    );
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const field of fields) {
    const name = `${field ?? ""}`.trim();
    if (!OCR_FIELD_NAME_PATTERN.test(name)) {
      throw new DocumentOcrError(
        "ocr_invalid_field_name",
        `Invalid field name: ${JSON.stringify(field)}. Expected ${OCR_FIELD_NAME_PATTERN}.`,
      );
    }
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(name);
    }
  }
  return normalized;
}

function decodeImage(imageBase64: unknown, contentType: unknown): string {
  if (typeof contentType !== "string" || !ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new DocumentOcrError(
      "ocr_unsupported_content_type",
      "contentType must be one of image/jpeg, image/png, image/webp.",
    );
  }
  if (
    typeof imageBase64 !== "string" ||
    imageBase64.length === 0 ||
    imageBase64.length % 4 !== 0 ||
    !STRICT_BASE64_PATTERN.test(imageBase64)
  ) {
    throw new DocumentOcrError(
      "ocr_invalid_image_base64",
      "imageBase64 must be strict RFC 4648 base64 without a data: prefix.",
    );
  }
  const bytes = Buffer.from(imageBase64, "base64");
  if (bytes.length === 0) {
    throw new DocumentOcrError(
      "ocr_invalid_image_base64",
      "imageBase64 decoded to zero bytes.",
    );
  }
  if (bytes.length > OCR_IMAGE_MAX_BYTES) {
    throw new DocumentOcrError(
      "ocr_image_too_large",
      `Decoded image exceeds the ${OCR_IMAGE_MAX_BYTES}-byte cap.`,
    );
  }
  return imageBase64;
}

function buildKiePrompt(fields: string[], documentHint?: string): string {
  const lines = [
    "You are a key-information-extraction engine for identity and delivery documents.",
    "Extract the following fields from the document image and answer with ONLY a JSON object.",
    `Required keys (exactly these, no others): ${fields.map((field) => JSON.stringify(field)).join(", ")}.`,
    `If a field is absent or illegible on the document, set its value to "${MISSING_FIELD_SENTINEL}".`,
    "Do not invent values. Do not add commentary, markdown, or keys that were not requested.",
  ];
  if (documentHint && documentHint.trim()) {
    lines.push(`Document type hint from the caller: ${documentHint.trim()}.`);
  }
  return lines.join("\n");
}

/**
 * Tolerant extraction of a JSON object from model output: accepts a bare
 * object, ```json fenced blocks, and prose with an embedded object.
 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(unfenced) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(unfenced.slice(start, end + 1)) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
    return null;
  }
}

type OllamaGenerateResponse = { response?: string };

/**
 * Single private owner of the Ollama payload shape. Uses /api/generate with
 * `images` (base64, no data: prefix), `format: "json"`, and `stream: false` —
 * the same endpoint family the LongCat speech-runtime already uses.
 */
function buildOllamaGeneratePayload(input: {
  model: string;
  prompt: string;
  imageBase64: string;
}) {
  return {
    model: input.model,
    prompt: input.prompt,
    images: [input.imageBase64],
    stream: false,
    format: "json",
  };
}

async function callOllamaGenerate(
  config: DocumentOcrConfig,
  payload: Record<string, unknown>,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${config.ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    // AbortController timeout and socket/DNS failures both land here; the
    // caller only needs to know the backend could not serve the request.
    throw new DocumentOcrError(
      "ocr_backend_unavailable",
      `Ollama backend unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new DocumentOcrError(
      "ocr_backend_error",
      `Ollama returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      response.status,
    );
  }
  const body = (await response.json().catch(() => null)) as OllamaGenerateResponse | null;
  if (!body || typeof body.response !== "string") {
    throw new DocumentOcrError(
      "ocr_response_unparseable",
      "Ollama response did not contain a text completion.",
    );
  }
  return body.response;
}

/**
 * Tolerant parse of a Jev score: the judge is prompted for a bare JSON object
 * but may answer with a bare number or fenced JSON. Returns null when no
 * usable 0..1 score is present (never fabricates one).
 */
export function parseJevScore(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && trimmed !== "") {
    return clamp(asNumber, 0, 1);
  }
  const object = extractJsonObject(trimmed);
  if (object) {
    const candidate = object.score ?? object.confidence ?? object.correctness;
    const parsed = typeof candidate === "string" ? Number(candidate) : candidate;
    if (typeof parsed === "number" && Number.isFinite(parsed)) {
      return clamp(parsed, 0, 1);
    }
  }
  const embedded = trimmed.match(/\b(?:0(?:\.\d+)?|1(?:\.0+)?)\b/);
  return embedded ? clamp(Number(embedded[0]), 0, 1) : null;
}

/**
 * Optional MiniCPM-OCR Jev judge pass: scores how correct the extracted value
 * is for the field's region on the document, 0..1. Returns null when the
 * judge cannot score (disabled, error, or unparseable output) — honesty over
 * fabricated confidence.
 */
export async function scoreExtractionConfidence(input: {
  config?: DocumentOcrConfig;
  imageBase64: string;
  field: string;
  value: string;
  documentHint?: string;
}): Promise<number | null> {
  const config = input.config ?? resolveDocumentOcrConfig();
  if (!config.jevEnabled || !config.ollamaUrl) return null;
  const prompt = [
    "You are an extraction judge. Score how correctly the proposed value matches",
    "the named field's region on the document image, from 0 (wrong) to 1 (correct).",
    `Field: ${JSON.stringify(input.field)}.`,
    `Proposed value: ${JSON.stringify(input.value)}.`,
    input.documentHint?.trim() ? `Document type hint: ${input.documentHint.trim()}.` : "",
    'Answer with ONLY a JSON object: {"score": <number between 0 and 1>}.',
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const raw = await callOllamaGenerate(
      config,
      buildOllamaGeneratePayload({
        model: config.jevModel,
        prompt,
        imageBase64: input.imageBase64,
      }),
    );
    return parseJevScore(raw);
  } catch {
    // A judge outage must not fail the extraction; it degrades to "no score",
    // which the confidence routing treats as unverifiable, not as correct.
    return null;
  }
}

export async function extractDocumentFields(
  input: ExtractDocumentFieldsInput,
  configOverride?: DocumentOcrConfig,
): Promise<ExtractDocumentFieldsResult> {
  const config = configOverride ?? resolveDocumentOcrConfig();
  if (!config.ollamaUrl) {
    throw new DocumentOcrError(
      "ocr_not_configured",
      "MiniCPM-OCR is not configured: set MINICPM_OCR_OLLAMA_URL or the shared OLLAMA_URL.",
    );
  }
  const fields = validateFieldNames(input.fields);
  const imageBase64 = decodeImage(input.imageBase64, input.contentType);

  const rawResponse = await callOllamaGenerate(
    config,
    buildOllamaGeneratePayload({
      model: config.model,
      prompt: buildKiePrompt(fields, input.documentHint),
      imageBase64,
    }),
  );
  const parsed = extractJsonObject(rawResponse);
  if (!parsed) {
    throw new DocumentOcrError(
      "ocr_response_unparseable",
      "MiniCPM-OCR output did not contain a JSON object.",
    );
  }

  const results: Record<string, DocumentFieldResult> = {};
  for (const field of fields) {
    const candidate = parsed[field];
    const raw =
      candidate == null
        ? null
        : typeof candidate === "string"
          ? candidate
          : JSON.stringify(candidate);
    const missing =
      raw == null || raw.trim() === "" || raw.trim() === MISSING_FIELD_SENTINEL;
    const value = missing ? null : (raw as string).trim();
    const confidence =
      value == null
        ? null
        : await scoreExtractionConfidence({
            config,
            imageBase64,
            field,
            value,
            documentHint: input.documentHint,
          });
    results[field] = {
      value,
      raw,
      confidence,
      needsReview: confidence !== null && confidence < config.reviewThreshold,
    };
  }

  return {
    model: config.model,
    documentHint: input.documentHint?.trim() || null,
    idempotencyKey: input.idempotencyKey?.trim() || null,
    jev: { enabled: config.jevEnabled, model: config.jevEnabled ? config.jevModel : null },
    fields: results,
  };
}
