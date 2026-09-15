import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getPool: vi.fn(),
}));
const fetchMocks = vi.hoisted(() => ({
  resilientFetch: vi.fn(),
}));

vi.mock("../server/db", () => dbMocks);
vi.mock("../server/_core/resilientFetch", () => fetchMocks);

import {
  assembleWorkRecordPayload,
  canonicalJson,
  getExport,
  getMyDataDisclosure,
  listMyExports,
  recordDisclosure,
  requestExport,
  sha256Hex,
  verifyExport,
} from "./_core/dataPortability";

type QueryResult = { rows: unknown[]; rowCount?: number };

function createPool(
  handlers: Array<{ match: RegExp; result: QueryResult | (() => QueryResult) }>,
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      const handler = handlers.find((candidate) => candidate.match.test(text));
      if (!handler) return { rows: [], rowCount: 0 };
      return typeof handler.result === "function"
        ? handler.result()
        : handler.result;
    }),
  };
}

function signerOkResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

const START = new Date("2026-01-01T00:00:00Z");
const END = new Date("2026-02-01T00:00:00Z");

const EXPORT_ROW = {
  id: "exp-1",
  user_id: 42,
  period_start: START.toISOString(),
  period_end: END.toISOString(),
  payload: { schema: "work-record/v1" },
  payload_hash: "abc123",
  signature: null,
  signer_key_id: null,
  signer_public_key: null,
  status: "pending",
  created_at: new Date().toISOString(),
  signed_at: null,
};

function assemblyPool() {
  return createPool([
    {
      match: /FROM public\.users WHERE id/,
      result: { rows: [{ id: 42, name: "Ada", email: "ada@example.com" }] },
    },
    { match: /FROM public\.rider_trips/, result: { rows: [] } },
    {
      match: /FROM public\.offer_economics_breakdowns/,
      result: {
        rows: [
          {
            offers: 3,
            gross_minor: "900000",
            deadhead_minor: "15000",
            platform_fee_minor: "180000",
            net_to_driver_minor: "720000",
          },
        ],
      },
    },
  ]);
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("canonicalJson / sha256Hex (pure)", () => {
  it("sorts object keys recursively and preserves array order", () => {
    const value = {
      b: 1,
      a: { d: [3, { z: 1, y: 2 }], c: "x" },
    };
    expect(canonicalJson(value)).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("is deterministic regardless of input key order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("sha256Hex hashes utf8 exactly", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("assembleWorkRecordPayload", () => {
  it("assembles profile, trips and earnings and documents known gaps", async () => {
    dbMocks.getPool.mockResolvedValue(assemblyPool());
    const payload = await assembleWorkRecordPayload(42, START, END);
    expect(payload.schema).toBe("work-record/v1");
    expect(payload.user_id).toBe(42);
    expect(payload.profile?.name).toBe("Ada");
    expect(payload.meta.sources).toEqual(
      expect.arrayContaining(["profile", "trips", "earnings"]),
    );
    expect(payload.meta.gaps).toEqual(
      expect.arrayContaining([
        "ratings_not_exportable_yet",
        "safety_device_not_exportable_yet",
      ]),
    );
  });

  it("degrades per-source when a table is unavailable", async () => {
    const pool = createPool([
      {
        match: /FROM public\.users WHERE id/,
        result: () => {
          throw new Error("relation does not exist");
        },
      },
      { match: /FROM public\.rider_trips/, result: { rows: [] } },
      {
        match: /FROM public\.offer_economics_breakdowns/,
        result: { rows: [] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const payload = await assembleWorkRecordPayload(42, START, END);
    expect(payload.profile).toBeNull();
    expect(payload.meta.gaps).toContain("profile_unavailable");
    expect(payload.meta.sources).not.toContain("profile");
  });
});

describe("requestExport", () => {
  it("walks pending -> signed when the signer is up", async () => {
    const signedRow = {
      ...EXPORT_ROW,
      status: "signed",
      signature: "c2ln",
      signer_key_id: "deadbeef",
      signer_public_key: "cHVi",
      signed_at: new Date().toISOString(),
    };
    const extra = [
      {
        match: /INSERT INTO public\.work_record_exports/,
        result: { rows: [EXPORT_ROW] },
      },
      {
        match: /UPDATE public\.work_record_exports/,
        result: { rows: [signedRow] },
      },
    ];
    const combined = createPool([
      {
        match: /FROM public\.users WHERE id/,
        result: { rows: [{ id: 42, name: "Ada" }] },
      },
      { match: /FROM public\.rider_trips/, result: { rows: [] } },
      {
        match: /FROM public\.offer_economics_breakdowns/,
        result: { rows: [{ offers: 0 }] },
      },
      ...extra,
    ]);
    dbMocks.getPool.mockResolvedValue(combined);
    fetchMocks.resilientFetch.mockResolvedValue(
      signerOkResponse({
        payload_hash: "hash-1",
        signature_b64: "c2ln",
        key_id: "deadbeef",
        public_key_b64: "cHVi",
      }),
    );

    const result = await requestExport(42, {
      periodStart: START,
      periodEnd: END,
    });
    expect(result.signed).toBe(true);
    expect(result.retryHint).toBeNull();
    expect(result.export.status).toBe("signed");

    const insert = combined.calls.find((call) =>
      /INSERT INTO public\.work_record_exports/.test(call.text),
    );
    expect(insert!.values[0]).toBe(42);
    expect(insert!.values[4]).toMatch(/^[0-9a-f]{64}$/); // payload_hash sha256

    const update = combined.calls.find((call) =>
      /UPDATE public\.work_record_exports/.test(call.text),
    );
    expect(update!.values.slice(1)).toEqual([
      "hash-1",
      "c2ln",
      "deadbeef",
      "cHVi",
    ]);
    expect(update!.text).toContain("status = 'signed'");

    // signer receives the canonical payload string
    const [, signerInit] = fetchMocks.resilientFetch.mock.calls[0]!;
    const signerBody = JSON.parse((signerInit as { body: string }).body);
    expect(typeof signerBody.payload).toBe("string");
    expect(signerBody.payload).toContain('"schema":"work-record/v1"');
  });

  it("keeps the export pending (never throws) when the signer is down", async () => {
    const pool = createPool([
      {
        match: /FROM public\.users WHERE id/,
        result: { rows: [{ id: 42 }] },
      },
      { match: /FROM public\.rider_trips/, result: { rows: [] } },
      {
        match: /FROM public\.offer_economics_breakdowns/,
        result: { rows: [] },
      },
      {
        match: /INSERT INTO public\.work_record_exports/,
        result: { rows: [EXPORT_ROW] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    fetchMocks.resilientFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const result = await requestExport(42, {
      periodStart: START,
      periodEnd: END,
    });
    expect(result.signed).toBe(false);
    expect(result.retryHint).toContain("signer_unavailable");
    expect(result.export.status).toBe("pending");
    expect(
      pool.calls.some((call) =>
        /UPDATE public\.work_record_exports/.test(call.text),
      ),
    ).toBe(false);
  });

  it("rejects an inverted period", async () => {
    dbMocks.getPool.mockResolvedValue(createPool([]));
    await expect(
      requestExport(42, { periodStart: END, periodEnd: START }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("listMyExports / getExport (own rows only)", () => {
  it("listMyExports scopes to the caller", async () => {
    const pool = createPool([
      {
        match: /FROM public\.work_record_exports\s+WHERE user_id/,
        result: { rows: [EXPORT_ROW] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const rows = await listMyExports(42);
    expect(rows).toHaveLength(1);
    expect(pool.calls[0]!.values).toEqual([42]);
  });

  it("getExport returns the caller's own export", async () => {
    const pool = createPool([
      {
        match: /FROM public\.work_record_exports\s+WHERE id = \$1 AND user_id = \$2/,
        result: { rows: [EXPORT_ROW] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const row = await getExport(42, { id: "exp-1" });
    expect(row.id).toBe("exp-1");
    expect(pool.calls[0]!.values).toEqual(["exp-1", 42]);
  });

  it("getExport hides another worker's export behind NOT_FOUND", async () => {
    const pool = createPool([
      {
        match: /FROM public\.work_record_exports\s+WHERE id = \$1 AND user_id = \$2/,
        result: { rows: [] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(getExport(43, { id: "exp-1" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("verifyExport", () => {
  it("returns the signer verdict when the verifier is up", async () => {
    fetchMocks.resilientFetch.mockResolvedValue(
      signerOkResponse({ valid: true }),
    );
    const result = await verifyExport({
      payload: '{"a":1}',
      signature: "c2ln",
      publicKey: "cHVi",
    });
    expect(result.valid).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.payloadHash).toBe(sha256Hex('{"a":1}'));
    expect(result.offlineVerify.instructions).toContain("sha256");
  });

  it("fails open with valid: null when the verifier is down", async () => {
    fetchMocks.resilientFetch.mockRejectedValue(new Error("breaker open"));
    const result = await verifyExport({
      payload: '{"a":1}',
      signature: "c2ln",
      publicKey: "cHVi",
    });
    expect(result.valid).toBeNull();
    expect(result.reason).toBe("verifier_unavailable");
    expect(result.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.offlineVerify.algorithm).toContain("ed25519");
  });

  it("fails open on a verifier 5xx response", async () => {
    fetchMocks.resilientFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as unknown as Response);
    const result = await verifyExport({
      payload: "x",
      signature: "s",
      publicKey: "p",
    });
    expect(result.valid).toBeNull();
    expect(result.reason).toBe("verifier_unavailable");
  });
});

describe("data transparency disclosures", () => {
  it("summarises every category plus live held-data counts", async () => {
    const pool = createPool([
      {
        match: /GROUP BY category/,
        result: {
          rows: [
            {
              category: "trips",
              disclosures: 2,
              last_disclosed_at: new Date().toISOString(),
            },
          ],
        },
      },
      {
        match: /EXISTS\(SELECT 1 FROM public\.users/,
        result: { rows: [{ exists: true }] },
      },
      {
        match: /FROM public\.rider_trips WHERE rider_user_id/,
        result: { rows: [{ c: 5 }] },
      },
      {
        match: /FROM public\.work_record_exports WHERE user_id/,
        result: { rows: [{ c: 1 }] },
      },
      {
        match: /FROM public\.data_transparency_disclosures\s+WHERE user_id/,
        result: { rows: [] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const summary = await getMyDataDisclosure(42);
    expect(summary.categories).toHaveLength(7);
    expect(
      summary.categories.find((entry) => entry.category === "trips")
        ?.disclosures,
    ).toBe(2);
    expect(
      summary.categories.find((entry) => entry.category === "profile")
        ?.disclosures,
    ).toBe(0);
    expect(summary.heldData).toEqual({ profile: true, trips: 5, exports: 1 });
  });

  it("recordDisclosure stamps the operator into detail", async () => {
    const row = {
      id: "disc-1",
      user_id: 42,
      category: "earnings",
      detail: { note: "take-rate change", recorded_by: 7 },
      disclosed_at: new Date().toISOString(),
    };
    const pool = createPool([
      {
        match: /INSERT INTO public\.data_transparency_disclosures/,
        result: { rows: [row] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const result = await recordDisclosure(7, {
      userId: 42,
      category: "earnings",
      detail: { note: "take-rate change" },
    });
    expect(result.category).toBe("earnings");
    const insert = pool.calls[0]!;
    expect(insert.values[0]).toBe(42);
    expect(JSON.parse(insert.values[2] as string)).toEqual({
      note: "take-rate change",
      recorded_by: 7,
    });
  });
});
