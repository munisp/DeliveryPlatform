/**
 * KYC document extraction wave (drizzle/0099) — unit + static tests.
 *
 * Covers:
 *   1. drizzle/0099_document_extraction.sql — static assertions in the style
 *      of tests/settlement-disputes.test.ts (append-only trigger, unique
 *      idempotency key, grants, field-shape validation).
 *   2. server/_core/stakeholderVerification.ts — recordDocumentExtraction /
 *      getCaseExtractions wrappers against a mocked pg pool (snake→camel
 *      mapping, parameter order, one() not-found path).
 *   3. server/routers.ts — router pins for the inline stakeholderVerification
 *      router (getExtractions procedure, recordEvidence imageBase64 input,
 *      fail-open fire-and-forget extraction block).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("pg", () => ({
  Pool: class MockPool {
    query = queryMock;
  },
}));

import {
  getCaseExtractions,
  recordDocumentExtraction,
} from "../server/_core/stakeholderVerification";

const CASE_ID = "2b1b6c3e-9f4d-4a3f-9b8d-0d2f6a1c5e77";
const EVIDENCE_ID = "6f0b2a4d-3d1c-4e5a-9c8b-7a6d5e4f3c21";

const SAMPLE_FIELDS = [
  { field: "full name", value: "Adaeze Obi", confidence: 0.91, needsReview: false },
  { field: "date of birth", value: null, confidence: null, needsReview: false },
];

// ---------------------------------------------------------------------------
// Migration static assertions (drizzle/0099), config-test style
// ---------------------------------------------------------------------------
const root = resolve(import.meta.dirname, "..");
const migration = readFileSync(
  resolve(root, "drizzle/0099_document_extraction.sql"),
  "utf8",
);

describe("drizzle/0099_document_extraction.sql", () => {
  it("creates the document_extraction table in the verification schema", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS verification.document_extraction",
    );
    expect(migration).toContain(
      "case_id uuid NOT NULL REFERENCES verification.verification_case(id)",
    );
    expect(migration).toContain(
      "evidence_id uuid NOT NULL REFERENCES verification.evidence(id)",
    );
    expect(migration).toContain("fields jsonb NOT NULL");
    expect(migration).toContain("jev_enabled boolean NOT NULL DEFAULT false");
    expect(migration).toContain("extracted_at timestamptz NOT NULL DEFAULT now()");
  });

  it("enforces the (case_id, evidence_id, idempotency_key) idempotency unique key", () => {
    expect(migration).toContain("UNIQUE (case_id, evidence_id, idempotency_key)");
    expect(migration).toContain(
      "ON CONFLICT(case_id,evidence_id,idempotency_key) DO NOTHING",
    );
  });

  it("is append-only via the shared prevent_append_only_mutation trigger", () => {
    expect(migration).toMatch(
      /CREATE TRIGGER verification_document_extraction_append_only BEFORE UPDATE OR DELETE ON verification\.document_extraction FOR EACH ROW EXECUTE FUNCTION verification\.prevent_append_only_mutation\(\)/,
    );
  });

  it("creates both SECURITY DEFINER functions with a pinned search_path", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION verification.record_document_extraction",
    );
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION verification.get_case_extractions",
    );
    const definerCount = migration.match(/SECURITY DEFINER/g) ?? [];
    expect(definerCount.length).toBeGreaterThanOrEqual(2);
    expect(migration).toContain("SET search_path=pg_catalog,verification");
  });

  it("validates the fields array shape element-by-element (22023 on malformed)", () => {
    expect(migration).toContain("jsonb_typeof(p_fields)<>'array'");
    expect(migration).toContain("jsonb_array_elements(p_fields)");
    expect(migration).toContain("v_field ? 'needsReview'");
    expect(migration).toContain("jsonb_typeof(v_field->'field')<>'string'");
    expect(migration).toContain("length(v_field->>'field') NOT BETWEEN 1 AND 64");
    expect(migration).toContain("jsonb_typeof(v_field->'needsReview')<>'boolean'");
    expect(migration).toContain("::numeric NOT BETWEEN 0 AND 1");
    expect(migration).toContain("USING ERRCODE='22023'");
  });

  it("gates recording on evidence supplier, case subject, or operator", () => {
    expect(migration).toContain("p_actor<>v_evidence.supplied_by_user_id");
    expect(migration).toContain("p_actor<>v_case.subject_user_id");
    expect(migration).toContain("verification.is_operator(p_actor)");
    expect(migration).toContain("ERRCODE='42501'");
  });

  it("gates reads on case subject, case creator, or operator", () => {
    expect(migration).toContain("v.subject_user_id=p_actor");
    expect(migration).toContain("v.created_by_user_id=p_actor");
  });

  it("returns rows with the frozen jsonb key set", () => {
    for (const key of [
      "'id'",
      "'case_id'",
      "'evidence_id'",
      "'model'",
      "'jev_enabled'",
      "'fields'",
      "'extracted_at'",
    ]) {
      expect(migration).toContain(key);
    }
    expect(migration).toContain("RETURNS SETOF jsonb");
  });

  it("guards the GRANT block behind a pg_roles existence check", () => {
    expect(migration).toContain("pg_roles");
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION verification.record_document_extraction(integer,uuid,uuid,text,boolean,jsonb,text,timestamptz) TO switchos_service",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION verification.get_case_extractions(integer,uuid) TO switchos_service",
    );
  });
});

// ---------------------------------------------------------------------------
// Wrapper mapping tests (mocked pool, no database)
// ---------------------------------------------------------------------------
describe("recordDocumentExtraction wrapper", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("passes the seven frozen parameters and stringifies the fields array", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "extraction-1" }] });
    const id = await recordDocumentExtraction({
      actorUserId: 7,
      caseId: CASE_ID,
      evidenceId: EVIDENCE_ID,
      model: "minicpm-ocr:1.0",
      jevEnabled: true,
      fields: SAMPLE_FIELDS,
      idempotencyKey: "extract-key-0001",
    });
    expect(id).toBe("extraction-1");
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain(
      "verification.record_document_extraction($1,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7)",
    );
    expect(params).toEqual([
      7,
      CASE_ID,
      EVIDENCE_ID,
      "minicpm-ocr:1.0",
      true,
      JSON.stringify(SAMPLE_FIELDS),
      "extract-key-0001",
    ]);
  });

  it("throws verification_document_extraction_not_found when no id comes back", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(
      recordDocumentExtraction({
        actorUserId: 7,
        caseId: CASE_ID,
        evidenceId: EVIDENCE_ID,
        model: "minicpm-ocr:1.0",
        jevEnabled: false,
        fields: SAMPLE_FIELDS,
        idempotencyKey: "extract-key-0002",
      }),
    ).rejects.toThrow("verification_document_extraction_not_found");
  });
});

describe("getCaseExtractions wrapper", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("maps snake_case jsonb rows to camelCase", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          get_case_extractions: {
            id: "extraction-1",
            case_id: CASE_ID,
            evidence_id: EVIDENCE_ID,
            model: "minicpm-ocr:1.0",
            jev_enabled: false,
            fields: SAMPLE_FIELDS,
            extracted_at: "2026-11-11T05:00:00.000000+00:00",
          },
        },
      ],
    });
    const rows = await getCaseExtractions(7, CASE_ID);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("verification.get_case_extractions($1,$2::uuid)");
    expect(params).toEqual([7, CASE_ID]);
    expect(rows).toEqual([
      {
        id: "extraction-1",
        caseId: CASE_ID,
        evidenceId: EVIDENCE_ID,
        model: "minicpm-ocr:1.0",
        jevEnabled: false,
        fields: SAMPLE_FIELDS,
        extractedAt: "2026-11-11T05:00:00.000000+00:00",
      },
    ]);
  });

  it("returns an empty array when the actor sees no extractions", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(getCaseExtractions(8, CASE_ID)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Router pins (static; the inline stakeholderVerification router is exercised
// end-to-end by the platform suite — here we pin the frozen surface)
// ---------------------------------------------------------------------------
const routers = readFileSync(resolve(root, "server/routers.ts"), "utf8");
const svRouter = routers.slice(
  routers.indexOf("stakeholderVerification: router({"),
  routers.indexOf("vehicleAccess: router({"),
);

describe("stakeholderVerification router surface", () => {
  it("exposes getExtractions wired to getCaseExtractions, mirroring getChecks", () => {
    expect(svRouter).toContain("getExtractions: authenticatedProcedure");
    expect(svRouter).toContain("getCaseExtractions(ctx.user!.id, input.caseId)");
  });

  it("recordEvidence accepts an optional imageBase64 payload (9 MB cap)", () => {
    expect(svRouter).toContain(
      "imageBase64: z.string().max(9_000_000).optional(),",
    );
  });

  it("imports extractDocumentFields from the documentOcr module", () => {
    expect(routers).toContain(
      'import { extractDocumentFields } from "./_core/documentOcr";',
    );
    expect(routers).toContain("recordDocumentExtraction");
    expect(routers).toContain("getCaseExtractions");
  });

  it("fires extraction fail-open after evidence recording, jpeg/png only", () => {
    expect(svRouter).toContain("const evidenceId = await recordVerificationEvidence(");
    expect(svRouter).toContain('input.contentType === "image/jpeg"');
    expect(svRouter).toContain('input.contentType === "image/png"');
    expect(svRouter).toContain("})().catch(() => {});");
    expect(svRouter).toContain("documentHint: input.evidenceKind");
    expect(svRouter).toContain("model: result.model");
    expect(svRouter).toContain("jevEnabled: result.jev.enabled");
  });
});
