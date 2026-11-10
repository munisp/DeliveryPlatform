/**
 * MiniCPM-OCR document extraction — unit tests.
 *
 * Covers fail-closed config, field/image validation, tolerant JSON parsing,
 * Jev confidence routing boundaries, timeout abort, and backend error paths.
 * fetch is stubbed via vi.stubGlobal; env is manipulated per test because
 * documentOcr resolves config at call time.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DocumentOcrError,
  extractDocumentFields,
  extractJsonObject,
  OCR_IMAGE_MAX_BYTES,
  parseJevScore,
  resolveDocumentOcrConfig,
  scoreExtractionConfidence,
  validateFieldNames,
} from "../server/_core/documentOcr";

const ENV_KEYS = [
  "MINICPM_OCR_OLLAMA_URL",
  "OLLAMA_URL",
  "MINICPM_OCR_MODEL",
  "MINICPM_OCR_TIMEOUT_MS",
  "MINICPM_OCR_JEV_ENABLED",
  "MINICPM_OCR_JEV_MODEL",
  "MINICPM_OCR_REVIEW_THRESHOLD",
] as const;

// 8-byte fake PNG payload, valid strict base64.
const TINY_IMAGE_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

function ollamaOk(responseText: string) {
  return new Response(JSON.stringify({ response: responseText }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("config resolution", () => {
  it("reuses the shared OLLAMA_URL from the speech-runtime", () => {
    process.env.OLLAMA_URL = "http://ollama.internal:11434/";
    const config = resolveDocumentOcrConfig();
    expect(config.ollamaUrl).toBe("http://ollama.internal:11434");
    expect(config.model).toBe("minicpm-ocr:1.0");
    expect(config.timeoutMs).toBe(60_000);
    expect(config.jevEnabled).toBe(false);
    expect(config.reviewThreshold).toBe(0.7);
  });

  it("MINICPM_OCR_OLLAMA_URL overrides the shared var and timeout is clamped", () => {
    process.env.OLLAMA_URL = "http://shared:11434";
    process.env.MINICPM_OCR_OLLAMA_URL = "http://gpu-ollama:11434";
    process.env.MINICPM_OCR_TIMEOUT_MS = "99999999";
    const config = resolveDocumentOcrConfig();
    expect(config.ollamaUrl).toBe("http://gpu-ollama:11434");
    expect(config.timeoutMs).toBe(300_000);
    process.env.MINICPM_OCR_TIMEOUT_MS = "1";
    expect(resolveDocumentOcrConfig().timeoutMs).toBe(5_000);
  });

  it("review threshold is clamped to 0..1", () => {
    process.env.MINICPM_OCR_REVIEW_THRESHOLD = "4";
    expect(resolveDocumentOcrConfig().reviewThreshold).toBe(1);
    process.env.MINICPM_OCR_REVIEW_THRESHOLD = "-2";
    expect(resolveDocumentOcrConfig().reviewThreshold).toBe(0);
  });
});

describe("fail-closed behavior", () => {
  it("throws ocr_not_configured when no Ollama URL is set", async () => {
    await expect(
      extractDocumentFields({
        imageBase64: TINY_IMAGE_BASE64,
        contentType: "image/png",
        fields: ["full_name"],
      }),
    ).rejects.toMatchObject({ code: "ocr_not_configured" });
  });

  it("maps network failure to ocr_backend_unavailable", async () => {
    process.env.OLLAMA_URL = "http://ollama:11434";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket hangup")));
    await expect(
      extractDocumentFields({
        imageBase64: TINY_IMAGE_BASE64,
        contentType: "image/png",
        fields: ["full_name"],
      }),
    ).rejects.toMatchObject({ code: "ocr_backend_unavailable" });
  });

  it("maps abort/timeout to ocr_backend_unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      }),
    );
    await expect(
      extractDocumentFields(
        {
          imageBase64: TINY_IMAGE_BASE64,
          contentType: "image/png",
          fields: ["full_name"],
        },
        // configOverride shortens the abort window so the test stays fast.
        { ...resolveDocumentOcrConfig(), ollamaUrl: "http://ollama:11434", timeoutMs: 50 },
      ),
    ).rejects.toMatchObject({ code: "ocr_backend_unavailable" });
  });

  it("surfaces non-200 responses with the HTTP status", async () => {
    process.env.OLLAMA_URL = "http://ollama:11434";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("model not found", { status: 404 })),
    );
    const error = await extractDocumentFields({
      imageBase64: TINY_IMAGE_BASE64,
      contentType: "image/png",
      fields: ["full_name"],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DocumentOcrError);
    expect((error as DocumentOcrError).code).toBe("ocr_backend_error");
    expect((error as DocumentOcrError).httpStatus).toBe(404);
    expect((error as DocumentOcrError).message).toContain("404");
  });
});

describe("input validation", () => {
  it("rejects invalid field names and over-long lists", () => {
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as DocumentOcrError).code;
      }
      return null;
    };
    expect(codeOf(() => validateFieldNames(["1bad"]))).toBe("ocr_invalid_field_name");
    expect(codeOf(() => validateFieldNames(["has-dash"]))).toBe("ocr_invalid_field_name");
    expect(codeOf(() => validateFieldNames([]))).toBe("ocr_no_fields");
    expect(
      codeOf(() => validateFieldNames(Array.from({ length: 33 }, (_v, i) => `field_${i}`))),
    ).toBe("ocr_too_many_fields");
    expect(validateFieldNames(["full_name", "Date of Birth"])).toEqual([
      "full_name",
      "Date of Birth",
    ]);
  });

  it("rejects unsupported content types", async () => {
    process.env.OLLAMA_URL = "http://ollama:11434";
    await expect(
      extractDocumentFields({
        imageBase64: TINY_IMAGE_BASE64,
        contentType: "image/gif",
        fields: ["full_name"],
      }),
    ).rejects.toMatchObject({ code: "ocr_unsupported_content_type" });
  });

  it("rejects images over the 6MB decoded cap", async () => {
    process.env.OLLAMA_URL = "http://ollama:11434";
    const oversize = Buffer.alloc(OCR_IMAGE_MAX_BYTES + 1, 0x41).toString("base64");
    await expect(
      extractDocumentFields({
        imageBase64: oversize,
        contentType: "image/jpeg",
        fields: ["full_name"],
      }),
    ).rejects.toMatchObject({ code: "ocr_image_too_large" });
  });
});

describe("tolerant JSON extraction", () => {
  it("parses bare, fenced, and prose-wrapped JSON objects", () => {
    expect(extractJsonObject('{"a": 1}')).toEqual({ a: 1 });
    expect(extractJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('```\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Sure! Here is the result: {"a": 1} hope that helps')).toEqual({ a: 1 });
    expect(extractJsonObject("not json at all")).toBeNull();
    expect(extractJsonObject("[1, 2]")).toBeNull();
    expect(extractJsonObject("")).toBeNull();
  });

  it("throws ocr_response_unparseable on non-JSON model output", async () => {
    process.env.OLLAMA_URL = "http://ollama:11434";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ollamaOk("I cannot read this document.")));
    await expect(
      extractDocumentFields({
        imageBase64: TINY_IMAGE_BASE64,
        contentType: "image/png",
        fields: ["full_name"],
      }),
    ).rejects.toMatchObject({ code: "ocr_response_unparseable" });
  });
});

describe("field extraction semantics", () => {
  it("maps missing/### fields to null and keeps raw values", async () => {
    process.env.OLLAMA_URL = "http://ollama:11434";
    const fetchMock = vi.fn().mockResolvedValue(
      ollamaOk('```json\n{"full_name": "Adaeze Obi", "nin": "###"}\n```'),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await extractDocumentFields({
      imageBase64: TINY_IMAGE_BASE64,
      contentType: "image/png",
      fields: ["full_name", "nin", "date_of_birth"],
      documentHint: "NIN slip",
    });
    expect(result.fields.full_name).toEqual({
      value: "Adaeze Obi",
      raw: "Adaeze Obi",
      confidence: null,
      needsReview: false,
    });
    expect(result.fields.nin).toEqual({ value: null, raw: "###", confidence: null, needsReview: false });
    expect(result.fields.date_of_birth).toEqual({ value: null, raw: null, confidence: null, needsReview: false });
    expect(result.jev).toEqual({ enabled: false, model: null });

    // Payload shape: /api/generate with images + format json.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://ollama:11434/api/generate");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("minicpm-ocr:1.0");
    expect(body.stream).toBe(false);
    expect(body.format).toBe("json");
    expect(body.images).toEqual([TINY_IMAGE_BASE64]);
    expect(body.prompt).toContain('"full_name"');
    expect(body.prompt).toContain("NIN slip");
  });
});

describe("Jev confidence routing", () => {
  function stubOllamaWithJev(jevScoreResponse: string) {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      // First call = extraction, second = judge.
      if (fetchMock.mock.calls.length === 1) {
        return Promise.resolve(ollamaOk('{"full_name": "Adaeze Obi"}'));
      }
      void url;
      return Promise.resolve(ollamaOk(jevScoreResponse));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("score exactly at the 0.7 threshold is NOT flagged for review", async () => {
    process.env.OLLAMA_URL = "http://ollama:11434";
    process.env.MINICPM_OCR_JEV_ENABLED = "true";
    stubOllamaWithJev('{"score": 0.7}');
    const result = await extractDocumentFields({
      imageBase64: TINY_IMAGE_BASE64,
      contentType: "image/png",
      fields: ["full_name"],
    });
    expect(result.fields.full_name.confidence).toBe(0.7);
    expect(result.fields.full_name.needsReview).toBe(false);
    expect(result.jev).toEqual({ enabled: true, model: "minicpm-ocr-jev:2b" });
  });

  it("score 0.69 is flagged for review", async () => {
    process.env.OLLAMA_URL = "http://ollama:11434";
    process.env.MINICPM_OCR_JEV_ENABLED = "true";
    stubOllamaWithJev('{"score": 0.69}');
    const result = await extractDocumentFields({
      imageBase64: TINY_IMAGE_BASE64,
      contentType: "image/png",
      fields: ["full_name"],
    });
    expect(result.fields.full_name.confidence).toBe(0.69);
    expect(result.fields.full_name.needsReview).toBe(true);
  });

  it("judge failure degrades to confidence null without failing extraction", async () => {
    process.env.OLLAMA_URL = "http://ollama:11434";
    process.env.MINICPM_OCR_JEV_ENABLED = "true";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ollamaOk('{"full_name": "Adaeze Obi"}'))
      .mockRejectedValueOnce(new Error("judge down"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await extractDocumentFields({
      imageBase64: TINY_IMAGE_BASE64,
      contentType: "image/png",
      fields: ["full_name"],
    });
    expect(result.fields.full_name.value).toBe("Adaeze Obi");
    expect(result.fields.full_name.confidence).toBeNull();
    expect(result.fields.full_name.needsReview).toBe(false);
  });

  it("scoreExtractionConfidence returns null when Jev is disabled", async () => {
    process.env.OLLAMA_URL = "http://ollama:11434";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const score = await scoreExtractionConfidence({
      imageBase64: TINY_IMAGE_BASE64,
      field: "full_name",
      value: "Adaeze Obi",
    });
    expect(score).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parseJevScore tolerates bare numbers, JSON, and clamps to 0..1", () => {
    expect(parseJevScore("0.85")).toBe(0.85);
    expect(parseJevScore('{"score": 0.4}')).toBe(0.4);
    expect(parseJevScore('```json\n{"score": 1.7}\n```')).toBe(1);
    expect(parseJevScore("score: 0.3 out of 1")).toBe(0.3);
    expect(parseJevScore("no score here")).toBeNull();
  });
});

describe("router pins", () => {
  it("documentOcrRouter uses authenticated extract and operator-tier extractForCase", () => {
    const source = readFileSync(
      path.join(__dirname, "../server/_core/documentOcrRouter.ts"),
      "utf8",
    );
    expect(source).toContain("export const documentOcrRouter = router({");
    expect(source).toContain("extract: authenticatedProcedure");
    expect(source).toContain('extractForCase: operatorMutationProcedure("operate")');
    expect(source).toContain("recordOperationalEvent");
    expect(source).toContain('eventType: "ai.document_ocr.extracted"');
    expect(source).not.toContain("publicProcedure");
    // No silent fabrication of confidence or values anywhere in the router.
    expect(source).not.toContain("confidence: 1");
  });
});
