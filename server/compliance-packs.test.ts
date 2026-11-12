/**
 * P4-C WS-COMPLIANCE tests (vitest): the write layer added to the
 * already-mounted compliancePacksRouter (upsert / deactivate / seed-defaults)
 * plus the mobilityQueries healthcare bridge onto vertical_compliance_packs
 * (0076) and the uncovered_verticals gap detector reflection.
 *
 * The Postgres boundary is a stateful fake pool emulating exactly the SQL
 * shapes issued by compliancePacksRouter.ts / compliancePacks.ts /
 * mobilityQueries.ts — including the 0076 UNIQUE(vertical_slug, jurisdiction)
 * upsert semantics, the jsonb_typeof CHECKs, and the 0072
 * consumer_processed_events idempotency ledger.
 */

import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getPool: vi.fn(),
}));

vi.mock("../server/db", () => dbMocks);

import {
  DEFAULT_COMPLIANCE_PACK_SEEDS,
  deactivateCompliancePackRecord,
  seedDefaultCompliancePacksRun,
  upsertCompliancePackInputSchema,
  upsertCompliancePackRecord,
} from "./_core/compliancePacksRouter";
import { getVerticalComplianceSummary } from "./_core/compliancePacks";
import { getHealthcareTransportSummary } from "./_core/mobilityQueries";

// ---------------------------------------------------------------------------
// Stateful fake pool
// ---------------------------------------------------------------------------

function pgError(code: string, message: string) {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

interface FakePackRow {
  id: number;
  vertical_id: number | null;
  vertical_slug: string;
  jurisdiction: string;
  required_documents: unknown;
  age_restriction: unknown;
  handling_requirements: unknown;
  active: boolean;
  updated_at: Date;
}

interface FakeVertical {
  id: number;
  name: string;
  slug: string;
  is_active: boolean;
}

const DEFAULT_VERTICALS: FakeVertical[] = [
  { id: 1, name: "Freight", slug: "freight", is_active: true },
  { id: 2, name: "Business Travel", slug: "business-travel", is_active: true },
  { id: 3, name: "Courier", slug: "courier", is_active: true },
  { id: 4, name: "Healthcare", slug: "healthcare", is_active: true },
];

function normalizeJsonb(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function createFakePool(options?: {
  verticals?: FakeVertical[];
  seedHealthcarePack?: boolean;
  failHealthcarePackRead?: boolean;
}) {
  const verticals = options?.verticals ?? DEFAULT_VERTICALS.map((v) => ({ ...v }));
  const packs = new Map<string, FakePackRow>();
  const ledger = new Map<string, unknown>();
  let packIdSeq = 0;
  const calls: Array<{ text: string; values: unknown[] }> = [];

  const keyOf = (slug: string, jurisdiction: string) => `${slug}|${jurisdiction}`;

  if (options?.seedHealthcarePack) {
    packIdSeq += 1;
    packs.set(keyOf("healthcare", "US baseline (HIPAA/HITECH + state health privacy law)"), {
      id: packIdSeq,
      vertical_id: 4,
      vertical_slug: "healthcare",
      jurisdiction: "US baseline (HIPAA/HITECH + state health privacy law)",
      required_documents: [
        {
          code: "patient_consent_record",
          label: "Patient consent for transport/delivery coordination",
          issuer: "patient_or_legal_guardian",
          verification: "signed_consent_on_file",
          renewal: "per_episode_of_care",
          retention_days: 2190,
        },
      ],
      age_restriction: null,
      handling_requirements: [
        {
          code: "chain_of_custody",
          label: "Chain-of-custody log for specimens and medical supplies",
          enforcement: "scan_events_at_each_handoff",
          parameters: { signature_required: true },
        },
      ],
      active: true,
      updated_at: new Date("2026-01-01T00:00:00.000Z"),
    });
  }

  async function query(text: string, values: unknown[] = []) {
    calls.push({ text, values });

    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text.trim())) return { rows: [] };
    if (/pg_advisory_xact_lock/.test(text)) return { rows: [] };

    // 0072 idempotency ledger
    if (/SELECT result_json FROM public\.consumer_processed_events/.test(text)) {
      const [consumer, topic, eventId] = values as string[];
      const hit = ledger.get(`${consumer}|${topic}|${eventId}`);
      return { rows: hit === undefined ? [] : [{ result_json: hit }] };
    }
    if (/INSERT INTO public\.consumer_processed_events/.test(text)) {
      const [consumer, topic, eventId, resultJson] = values as string[];
      const key = `${consumer}|${topic}|${eventId}`;
      if (!ledger.has(key)) ledger.set(key, JSON.parse(resultJson));
      return { rows: [] };
    }

    // 0076 upsert honoring UNIQUE(vertical_slug, jurisdiction) + jsonb CHECKs
    if (/INSERT INTO public\.vertical_compliance_packs/.test(text)) {
      const [slug, jurisdiction, docsJson, ageJson, handlingJson, active] =
        values as [string, string, string, string | null, string, boolean];
      const docs = normalizeJsonb(docsJson);
      const handling = normalizeJsonb(handlingJson);
      const age = ageJson == null ? null : normalizeJsonb(ageJson);
      if (!Array.isArray(docs)) {
        throw pgError("23514", 'new row violates check constraint "required_documents must be array"');
      }
      if (!Array.isArray(handling)) {
        throw pgError("23514", 'new row violates check constraint "handling_requirements must be array"');
      }
      if (age !== null && (typeof age !== "object" || Array.isArray(age))) {
        throw pgError("23514", 'new row violates check constraint "age_restriction must be object"');
      }
      const vertical = verticals.find((v) => v.slug === slug) ?? null;
      const existing = packs.get(keyOf(slug, jurisdiction));
      if (existing) {
        existing.vertical_id = vertical?.id ?? null;
        existing.required_documents = docs;
        existing.age_restriction = age;
        existing.handling_requirements = handling;
        existing.active = active;
        existing.updated_at = new Date();
        return { rows: [{ id: existing.id, inserted: false }] };
      }
      packIdSeq += 1;
      const row: FakePackRow = {
        id: packIdSeq,
        vertical_id: vertical?.id ?? null,
        vertical_slug: slug,
        jurisdiction,
        required_documents: docs,
        age_restriction: age,
        handling_requirements: handling,
        active,
        updated_at: new Date(),
      };
      packs.set(keyOf(slug, jurisdiction), row);
      return { rows: [{ id: row.id, inserted: true }] };
    }

    if (/UPDATE public\.vertical_compliance_packs\s+SET active = false/.test(text)) {
      const [slug, jurisdiction] = values as string[];
      const existing = packs.get(keyOf(slug, jurisdiction));
      if (!existing) return { rows: [] };
      existing.active = false;
      existing.updated_at = new Date();
      return { rows: [{ id: existing.id, active: false }] };
    }

    // PACK_SELECT (compliancePacks.ts list/summary)
    if (/FROM public\.vertical_compliance_packs p\s+LEFT JOIN public\.service_verticals v/.test(text)) {
      let rows = [...packs.values()].map((row) => ({
        ...row,
        vertical_name:
          verticals.find((v) => v.id === row.vertical_id)?.name ?? null,
      }));
      const filterMatch = /LOWER\(p\.vertical_slug\) = \$1/.test(text);
      if (filterMatch) {
        const needle = String(values[0]).toLowerCase();
        rows = rows.filter(
          (row) =>
            row.vertical_slug.toLowerCase() === needle ||
            (row.vertical_name ?? "").toLowerCase() === needle,
        );
      }
      rows.sort((a, b) =>
        a.active === b.active
          ? a.vertical_slug.localeCompare(b.vertical_slug) ||
            a.jurisdiction.localeCompare(b.jurisdiction)
          : a.active
            ? -1
            : 1,
      );
      return { rows };
    }

    if (/FROM public\.service_verticals\s+WHERE is_active/.test(text)) {
      return {
        rows: verticals
          .filter((v) => v.is_active)
          .map((v) => ({ id: v.id, name: v.name, slug: v.slug })),
      };
    }

    // mobilityQueries healthcare bridge read
    if (/FROM public\.vertical_compliance_packs\s+WHERE vertical_slug = 'healthcare'/.test(text)) {
      if (options?.failHealthcarePackRead) {
        throw pgError("42P01", 'relation "public.vertical_compliance_packs" does not exist');
      }
      const rows = [...packs.values()].filter(
        (row) => row.vertical_slug === "healthcare" && row.active,
      );
      return {
        rows: rows.map((row) => ({
          required_documents: row.required_documents,
          handling_requirements: row.handling_requirements,
        })),
      };
    }

    // mobilityQueries summary counts / row sets
    if (/COUNT\(DISTINCT program\)::int AS c FROM healthcare_transport_bookings/.test(text)) {
      return { rows: [{ c: 0 }] };
    }
    if (/COUNT\(\*\)::int AS c FROM healthcare_transport_bookings/.test(text)) {
      return { rows: [{ c: 0 }] };
    }
    if (/COUNT\(\*\)::int AS c FROM service_providers/.test(text)) {
      return { rows: [{ c: 0 }] };
    }
    if (/FROM healthcare_transport_bookings\s+GROUP BY program/.test(text)) {
      return { rows: [] };
    }
    if (/FROM healthcare_transport_bookings\s+WHERE status IN/.test(text)) {
      return { rows: [] };
    }

    return { rows: [] };
  }

  return {
    calls,
    packs,
    ledger,
    query: vi.fn(query),
    connect: vi.fn(async () => ({
      query: vi.fn(query),
      release: vi.fn(),
    })),
  };
}

const ACTOR = 42;

function validPackInput(overrides?: Record<string, unknown>) {
  return {
    verticalSlug: "freight",
    jurisdiction: "NG federal baseline (test)",
    requiredDocuments: [
      {
        code: "haulage_operator_permit",
        label: "Road haulage operator permit",
        issuer: "federal_ministry_of_transport",
        verification: "permit_number_lookup",
        renewal: "annual",
        retention_days: 1825,
      },
    ],
    ageRestriction: null,
    handlingRequirements: [
      {
        code: "proof_of_delivery",
        label: "Signed proof of delivery",
        enforcement: "signature_capture_at_dropoff",
        parameters: { allow_unattended_dropoff: false },
      },
    ],
    idempotencyKey: "upsert-key-0001",
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("compliance pack idempotency schema", () => {
  it("accepts keys matching IDEMPOTENCY_KEY_REGEX", () => {
    const parsed = upsertCompliancePackInputSchema.safeParse(validPackInput());
    expect(parsed.success).toBe(true);
  });

  it("rejects malformed idempotency keys at the schema boundary", () => {
    for (const bad of ["short", "has spaces!!", "-leading-dash-1234", "x".repeat(200)]) {
      const parsed = upsertCompliancePackInputSchema.safeParse(
        validPackInput({ idempotencyKey: bad }),
      );
      expect(parsed.success).toBe(false);
    }
  });

  it("rejects non-array required_documents so the 0076 jsonb CHECK can never fire on well-formed input", () => {
    const parsed = upsertCompliancePackInputSchema.safeParse(
      validPackInput({ requiredDocuments: { code: "not-an-array" } }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe("upsertCompliancePack", () => {
  it("creates a new pack via ON CONFLICT upsert (inserted)", async () => {
    const pool = createFakePool();
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await upsertCompliancePackRecord(ACTOR, validPackInput());
    expect(result.replayed).toBe(false);
    expect(result.created).toBe(true);
    expect(result.active).toBe(true);
    expect(pool.packs.size).toBe(1);
    const row = [...pool.packs.values()][0];
    expect(row.vertical_slug).toBe("freight");
    expect(row.vertical_id).toBe(1); // linked to service_verticals by slug
    expect(row.required_documents).toHaveLength(1);
  });

  it("updates in place on (vertical_slug, jurisdiction) conflict", async () => {
    const pool = createFakePool();
    dbMocks.getPool.mockResolvedValue(pool);

    const first = await upsertCompliancePackRecord(ACTOR, validPackInput());
    const second = await upsertCompliancePackRecord(
      ACTOR,
      validPackInput({
        idempotencyKey: "upsert-key-0002",
        requiredDocuments: [
          {
            code: "vehicle_roadworthiness",
            label: "Vehicle roadworthiness certificate",
            issuer: "frsc_vehicle_inspection_service",
            verification: "certificate_number_lookup",
            renewal: "annual",
            retention_days: 1095,
          },
        ],
      }),
    );
    expect(second.created).toBe(false);
    expect(second.packId).toBe(first.packId);
    expect(pool.packs.size).toBe(1);
    const row = [...pool.packs.values()][0];
    expect(row.required_documents).toHaveLength(1);
    expect((row.required_documents as any[])[0].code).toBe("vehicle_roadworthiness");
  });

  it("replays the same idempotency key without a second write", async () => {
    const pool = createFakePool();
    dbMocks.getPool.mockResolvedValue(pool);

    const first = await upsertCompliancePackRecord(ACTOR, validPackInput());
    const replay = await upsertCompliancePackRecord(ACTOR, validPackInput());
    expect(replay.replayed).toBe(true);
    expect(replay.packId).toBe(first.packId);
    expect(replay.created).toBe(first.created);
    const insertCalls = pool.calls.filter((c) =>
      /INSERT INTO public\.vertical_compliance_packs/.test(c.text),
    );
    expect(insertCalls).toHaveLength(1);
  });

  it("maps a DB-side CHECK violation (23514) to CONFLICT", async () => {
    const pool = createFakePool();
    dbMocks.getPool.mockResolvedValue(pool);

    // Bypass zod (direct function call) to exercise the DB CHECK mapping.
    const bad = validPackInput({
      requiredDocuments: { code: "not-an-array" },
    }) as any;
    const error = await upsertCompliancePackRecord(ACTOR, bad).catch((e) => e);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("CONFLICT");
    expect(pool.packs.size).toBe(0);
  });
});

describe("deactivateCompliancePack", () => {
  it("soft-deactivates an existing pack", async () => {
    const pool = createFakePool();
    dbMocks.getPool.mockResolvedValue(pool);

    await upsertCompliancePackRecord(ACTOR, validPackInput());
    const result = await deactivateCompliancePackRecord(ACTOR, {
      verticalSlug: "freight",
      jurisdiction: "NG federal baseline (test)",
      idempotencyKey: "deactivate-key-1",
    });
    expect(result.active).toBe(false);
    expect(result.replayed).toBe(false);
    expect([...pool.packs.values()][0].active).toBe(false);
  });

  it("returns NOT_FOUND for an unknown pack", async () => {
    const pool = createFakePool();
    dbMocks.getPool.mockResolvedValue(pool);

    const error = await deactivateCompliancePackRecord(ACTOR, {
      verticalSlug: "freight",
      jurisdiction: "nowhere",
      idempotencyKey: "deactivate-key-2",
    }).catch((e) => e);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("NOT_FOUND");
  });
});

describe("seedDefaultCompliancePacks", () => {
  it("seeds freight / business-travel / courier packs with NG federal + Lagos jurisdictions", async () => {
    const pool = createFakePool();
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await seedDefaultCompliancePacksRun(ACTOR, {
      idempotencyKey: "seed-defaults-01",
    });
    expect(result.replayed).toBe(false);
    expect(result.verticals.sort()).toEqual(["business-travel", "courier", "freight"]);
    expect(result.packsTouched).toBe(DEFAULT_COMPLIANCE_PACK_SEEDS.length);
    expect(result.inserted).toBe(DEFAULT_COMPLIANCE_PACK_SEEDS.length);
    expect(result.updated).toBe(0);
    const slugs = new Set([...pool.packs.values()].map((p) => p.vertical_slug));
    expect(slugs).toEqual(new Set(["freight", "business-travel", "courier"]));
    const jurisdictions = [...pool.packs.values()].map((p) => p.jurisdiction);
    expect(jurisdictions.some((j) => j.startsWith("NG federal baseline"))).toBe(true);
    expect(jurisdictions.some((j) => j.startsWith("NG-LA Lagos State"))).toBe(true);
  });

  it("double run is a no-op: same pack count, zero new inserts, stable summary", async () => {
    const pool = createFakePool();
    dbMocks.getPool.mockResolvedValue(pool);

    await seedDefaultCompliancePacksRun(ACTOR, { idempotencyKey: "seed-defaults-02" });
    const countAfterFirst = pool.packs.size;
    const second = await seedDefaultCompliancePacksRun(ACTOR, {
      idempotencyKey: "seed-defaults-03",
    });
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(DEFAULT_COMPLIANCE_PACK_SEEDS.length);
    expect(pool.packs.size).toBe(countAfterFirst);
  });

  it("replays the same seed key from the ledger without touching packs", async () => {
    const pool = createFakePool();
    dbMocks.getPool.mockResolvedValue(pool);

    await seedDefaultCompliancePacksRun(ACTOR, { idempotencyKey: "seed-defaults-04" });
    const insertCallsAfterFirst = pool.calls.filter((c) =>
      /INSERT INTO public\.vertical_compliance_packs/.test(c.text),
    ).length;
    const replay = await seedDefaultCompliancePacksRun(ACTOR, {
      idempotencyKey: "seed-defaults-04",
    });
    expect(replay.replayed).toBe(true);
    const insertCallsAfterReplay = pool.calls.filter((c) =>
      /INSERT INTO public\.vertical_compliance_packs/.test(c.text),
    ).length;
    expect(insertCallsAfterReplay).toBe(insertCallsAfterFirst);
  });

  it("uncovered_verticals gap detector reflects the new seeds", async () => {
    const pool = createFakePool();
    dbMocks.getPool.mockResolvedValue(pool);

    const before = await getVerticalComplianceSummary();
    const uncoveredBefore = before.uncovered_verticals.map((v) => v.slug);
    expect(uncoveredBefore).toEqual(
      expect.arrayContaining(["freight", "business-travel", "courier", "healthcare"]),
    );

    await seedDefaultCompliancePacksRun(ACTOR, { idempotencyKey: "seed-defaults-05" });

    const after = await getVerticalComplianceSummary();
    const uncoveredAfter = after.uncovered_verticals.map((v) => v.slug);
    expect(uncoveredAfter).not.toContain("freight");
    expect(uncoveredAfter).not.toContain("business-travel");
    expect(uncoveredAfter).not.toContain("courier");
    expect(uncoveredAfter).toContain("healthcare"); // no healthcare seed here
    expect(after.summary.active_packs).toBe(DEFAULT_COMPLIANCE_PACK_SEEDS.length);
  });
});

describe("healthcare compliance pack bridge (mobilityQueries)", () => {
  it("serves pack labels from vertical_compliance_packs when rows exist", async () => {
    const pool = createFakePool({ seedHealthcarePack: true });
    dbMocks.getPool.mockResolvedValue(pool);

    const summary = await getHealthcareTransportSummary();
    expect(summary.compliance_packs).toEqual(
      expect.arrayContaining([
        "Patient consent for transport/delivery coordination",
        "Chain-of-custody log for specimens and medical supplies",
      ]),
    );
    expect(summary.compliance_packs).not.toContain("HIPAA-sensitive notes");
    expect(summary.summary.compliance_packs).toBe(summary.compliance_packs.length);
  });

  it("falls back to the hardcoded const ONLY when the table read returns zero rows", async () => {
    const pool = createFakePool(); // no healthcare pack rows
    dbMocks.getPool.mockResolvedValue(pool);

    const summary = await getHealthcareTransportSummary();
    expect(summary.compliance_packs).toEqual([
      "Patient identity verification",
      "HIPAA-sensitive notes",
      "Chain of custody",
      "Prescription handoff validation",
    ]);
    expect(summary.summary.compliance_packs).toBe(4);
  });

  it("never throws when the pack table is unavailable — falls back to the const", async () => {
    const pool = createFakePool({ failHealthcarePackRead: true });
    dbMocks.getPool.mockResolvedValue(pool);

    const summary = await getHealthcareTransportSummary();
    expect(summary.compliance_packs).toContain("Chain of custody");
    expect(summary.summary.compliance_packs).toBe(4);
  });
});
