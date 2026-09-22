import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getPool: vi.fn(),
}));
const councilMocks = vi.hoisted(() => ({
  postConsultation: vi.fn(),
  assertConsultationEligible: vi.fn(),
}));

vi.mock("../server/db", () => dbMocks);
vi.mock("../server/_core/workerCouncil", () => councilMocks);

import {
  DEFAULT_DISPUTE_FORUM,
  DEFAULT_GOVERNING_LAW,
  getContractDefaults,
  invalidateContractDefaultsCache,
  publishContractDefaults,
  setContractDefaults,
} from "./_core/contractDefaults";

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

const JURISDICTION = {
  id: "jur-1",
  market_id: "lagos",
  governing_law: "Federal Republic of Nigeria",
  dispute_forum: "Lagos, Nigeria courts",
  consumer_protection_overrides: {},
  effective_from: new Date().toISOString(),
  published: false,
  consultation_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

beforeEach(() => {
  vi.resetAllMocks();
  invalidateContractDefaultsCache(); // hot-read cache must not leak between tests
});

describe("Nigerian-law defaults (R15)", () => {
  it("hard constants are Nigerian law and Lagos courts", () => {
    expect(DEFAULT_GOVERNING_LAW).toBe("Federal Republic of Nigeria");
    expect(DEFAULT_DISPUTE_FORUM).toBe("Lagos, Nigeria courts");
  });

  it("a market without a row resolves to the Nigerian defaults", async () => {
    const pool = createPool([
      {
        match: /FROM public\.contract_jurisdictions WHERE market_id/,
        result: { rows: [] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const defaults = await getContractDefaults("kano");
    expect(defaults.governingLaw).toBe("Federal Republic of Nigeria");
    expect(defaults.disputeForum).toBe("Lagos, Nigeria courts");
    expect(defaults.isDefault).toBe(true);
    expect(defaults.published).toBe(false);
  });

  it("returns the stored row when one exists", async () => {
    const pool = createPool([
      {
        match: /FROM public\.contract_jurisdictions WHERE market_id/,
        result: { rows: [{ ...JURISDICTION, published: true }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const defaults = await getContractDefaults("lagos");
    expect(defaults.isDefault).toBe(false);
    expect(defaults.published).toBe(true);
  });
});

describe("setContractDefaults", () => {
  it("upserts with Nigerian defaults when fields are omitted and auto-posts a council consultation", async () => {
    const pool = createPool([
      {
        match: /INSERT INTO public\.contract_jurisdictions/,
        result: { rows: [JURISDICTION] },
      },
      {
        match: /UPDATE public\.contract_jurisdictions/,
        result: { rows: [{ ...JURISDICTION, consultation_id: "cons-1" }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    councilMocks.postConsultation.mockResolvedValue({ id: "cons-1" });

    const result = await setContractDefaults(7, { marketId: "lagos" });
    expect(result.consultationId).toBe("cons-1");

    const upsert = pool.calls.find((call) =>
      /INSERT INTO public\.contract_jurisdictions/.test(call.text),
    );
    expect(upsert!.values[0]).toBe("lagos");
    expect(upsert!.values[1]).toBe("Federal Republic of Nigeria");
    expect(upsert!.values[2]).toBe("Lagos, Nigeria courts");

    expect(councilMocks.postConsultation).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        kind: "other",
        payload: expect.objectContaining({ market_id: "lagos" }),
      }),
    );
  });

  it("re-publication resets published to false until the gate clears again", async () => {
    const pool = createPool([
      {
        match: /INSERT INTO public\.contract_jurisdictions/,
        result: { rows: [JURISDICTION] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    councilMocks.postConsultation.mockRejectedValue(new Error("council down"));

    const result = await setContractDefaults(7, {
      marketId: "lagos",
      disputeForum: "Abuja, Nigeria courts",
    });
    expect(result.consultationId).toBeNull(); // fail-open
    const upsert = pool.calls.find((call) =>
      /INSERT INTO public\.contract_jurisdictions/.test(call.text),
    );
    expect(upsert!.text).toContain("published = false");
    expect(upsert!.values[2]).toBe("Abuja, Nigeria courts");
  });
});

describe("publishContractDefaults (consultation gate)", () => {
  it("publishes once the consultation is activated/SLA-eligible", async () => {
    councilMocks.assertConsultationEligible.mockResolvedValue({
      id: "cons-1",
      status: "activated",
    });
    const pool = createPool([
      {
        match: /UPDATE public\.contract_jurisdictions/,
        result: {
          rows: [
            { ...JURISDICTION, published: true, consultation_id: "cons-1" },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const row = await publishContractDefaults(7, {
      marketId: "lagos",
      consultationId: "cons-1",
    });
    expect(row.published).toBe(true);
    expect(councilMocks.assertConsultationEligible).toHaveBeenCalledWith(
      "cons-1",
      "other",
    );
  });

  it("refuses to publish when the consultation gate is unmet", async () => {
    councilMocks.assertConsultationEligible.mockRejectedValue(
      Object.assign(new Error("consultation_gate_unmet"), {
        code: "CONFLICT",
      }),
    );
    const pool = createPool([]);
    dbMocks.getPool.mockResolvedValue(pool);

    await expect(
      publishContractDefaults(7, {
        marketId: "lagos",
        consultationId: "cons-1",
      }),
    ).rejects.toThrowError(/consultation_gate_unmet/);
    expect(
      pool.calls.some((call) =>
        /UPDATE public\.contract_jurisdictions/.test(call.text),
      ),
    ).toBe(false);
  });

  it("is NOT_FOUND for a market with no jurisdiction row", async () => {
    councilMocks.assertConsultationEligible.mockResolvedValue({
      id: "cons-1",
      status: "activated",
    });
    const pool = createPool([
      {
        match: /UPDATE public\.contract_jurisdictions/,
        result: { rows: [] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      publishContractDefaults(7, {
        marketId: "nowhere",
        consultationId: "cons-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("contract defaults hot-read cache", () => {
  it("serves repeated getContractDefaults reads from cache (one DB query)", async () => {
    const pool = createPool([
      {
        match: /FROM public\.contract_jurisdictions WHERE market_id/,
        result: { rows: [{ ...JURISDICTION, published: true }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const first = await getContractDefaults("lagos");
    const second = await getContractDefaults("lagos");
    expect(first.isDefault).toBe(false);
    expect(second).toEqual(first);
    expect(
      pool.calls.filter((call) =>
        /FROM public\.contract_jurisdictions WHERE market_id/.test(call.text),
      ),
    ).toHaveLength(1);
  });

  it("caches the Nigerian-law fallback resolution", async () => {
    const pool = createPool([
      {
        match: /FROM public\.contract_jurisdictions WHERE market_id/,
        result: { rows: [] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const first = await getContractDefaults("kano");
    const second = await getContractDefaults("kano");
    expect(first.isDefault).toBe(true);
    expect(second).toEqual(first);
    expect(
      pool.calls.filter((call) =>
        /FROM public\.contract_jurisdictions WHERE market_id/.test(call.text),
      ),
    ).toHaveLength(1);
  });

  it("setContractDefaults invalidates the cached defaults for the market", async () => {
    const pool = createPool([
      {
        match: /SELECT .* FROM public\.contract_jurisdictions WHERE market_id/,
        result: { rows: [] },
      },
      {
        match: /INSERT INTO public\.contract_jurisdictions/,
        result: { rows: [JURISDICTION] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    councilMocks.postConsultation.mockResolvedValue({ id: "cons-1" });

    const before = await getContractDefaults("lagos"); // prime cache (fallback)
    expect(before.isDefault).toBe(true);
    await setContractDefaults(7, { marketId: "lagos" });
    const after = await getContractDefaults("lagos"); // must re-read
    expect(
      pool.calls.filter((call) =>
        /SELECT .* FROM public\.contract_jurisdictions WHERE market_id/.test(call.text),
      ),
    ).toHaveLength(2);
  });

  it("publishContractDefaults invalidates the cached defaults for the market", async () => {
    councilMocks.assertConsultationEligible.mockResolvedValue({
      id: "cons-1",
      status: "activated",
    });
    let published = false;
    const pool = createPool([
      {
        match: /SELECT .* FROM public\.contract_jurisdictions WHERE market_id/,
        result: () => ({
          rows: [{ ...JURISDICTION, published }],
        }),
      },
      {
        match: /UPDATE public\.contract_jurisdictions/,
        result: () => {
          published = true;
          return {
            rows: [{ ...JURISDICTION, published: true, consultation_id: "cons-1" }],
          };
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const before = await getContractDefaults("lagos"); // prime cache
    expect(before.published).toBe(false);
    await publishContractDefaults(7, { marketId: "lagos", consultationId: "cons-1" });
    const after = await getContractDefaults("lagos"); // must re-read
    expect(after.published).toBe(true);
    expect(
      pool.calls.filter((call) =>
        /SELECT .* FROM public\.contract_jurisdictions WHERE market_id/.test(call.text),
      ),
    ).toHaveLength(2);
  });

  it("invalidation is scoped per market", async () => {
    const pool = createPool([
      {
        match: /FROM public\.contract_jurisdictions WHERE market_id/,
        result: { rows: [] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await getContractDefaults("lagos");
    await getContractDefaults("kano");
    invalidateContractDefaultsCache("lagos");
    await getContractDefaults("lagos"); // re-reads
    await getContractDefaults("kano"); // still cached
    expect(
      pool.calls.filter((call) =>
        /FROM public\.contract_jurisdictions WHERE market_id/.test(call.text),
      ),
    ).toHaveLength(3);
  });
});
