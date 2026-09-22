import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getPool: vi.fn(),
}));

vi.mock("../server/db", () => dbMocks);

import {
  getMyVerificationStatus,
  getOfferRiderBadge,
  hashIdReference,
  invalidateVerificationStatusCache,
  screenName,
  submitVerification,
} from "./_core/riderVerification";
import { resetFailOpenFastBreaker } from "./_core/resilientFetch";

type QueryResult = { rows: unknown[]; rowCount?: number };

function createPool(handlers: Array<{ match: RegExp; result: QueryResult }>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      const handler = handlers.find((candidate) => candidate.match.test(text));
      if (!handler) return { rows: [], rowCount: 0 };
      return handler.result;
    }),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  invalidateVerificationStatusCache(); // hot-read cache must not leak between tests
  resetFailOpenFastBreaker(); // shared screening breaker must not leak either
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hashIdReference", () => {
  it("stores only the sha256 digest of the ID reference, never the raw value", () => {
    const raw = "12345678901";
    const digest = hashIdReference(raw);
    expect(digest).toBe(createHash("sha256").update(raw, "utf8").digest("hex"));
    expect(digest).not.toContain(raw);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("screenName", () => {
  it("returns the service verdict when verification-intelligence responds", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ score: 0.12, flags: ["pseudonym"], plausible: false }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await screenName("Snake");
    expect(result).toEqual({
      score: 0.12,
      flags: ["pseudonym"],
      plausible: false,
      unavailable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/screen-name");
    expect(init.method).toBe("POST");
  });

  it("fails closed with service_unavailable flag when the service is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await screenName("Adaeze Okafor");
    expect(result).toEqual({
      score: null,
      flags: ["service_unavailable"],
      plausible: false,
      unavailable: true,
    });
    expect(warn).toHaveBeenCalled();
  });
});

describe("getMyVerificationStatus", () => {
  it("auto-creates an unverified row when none exists", async () => {
    const pool = createPool([
      { match: /SELECT \* FROM public\.rider_verifications WHERE user_id/, result: { rows: [] } },
      {
        match: /INSERT INTO public\.rider_verifications/,
        result: {
          rows: [
            {
              id: "v-1",
              user_id: 42,
              status: "unverified",
              name_screening_flags: [],
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const status = await getMyVerificationStatus(42);
    expect(status).toEqual({ status: "unverified", badgeLevel: "none", flags: [] });
    expect(
      pool.calls.some((call) => /INSERT INTO public\.rider_verifications/.test(call.text)),
    ).toBe(true);
  });

  it("reports verified badge for a verified rider", async () => {
    const pool = createPool([
      {
        match: /SELECT \* FROM public\.rider_verifications WHERE user_id/,
        result: {
          rows: [
            {
              id: "v-1",
              user_id: 42,
              status: "verified",
              name_screening_flags: ["reviewed"],
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const status = await getMyVerificationStatus(42);
    expect(status.badgeLevel).toBe("verified");
    expect(status.flags).toEqual(["reviewed"]);
  });
});

describe("submitVerification", () => {
  function submissionPool() {
    return createPool([
      {
        match: /SELECT \* FROM public\.rider_verifications WHERE user_id/,
        result: {
          rows: [
            { id: "v-1", user_id: 42, status: "unverified", name_screening_flags: [] },
          ],
        },
      },
      { match: /UPDATE public\.rider_verifications/, result: { rows: [], rowCount: 1 } },
      { match: /INSERT INTO public\.rider_name_screenings/, result: { rows: [], rowCount: 1 } },
    ]);
  }

  it("auto-verifies a valid ID reference with a plausible name and captured consent, storing only the hash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ score: 0.95, flags: [], plausible: true })),
    );
    const pool = submissionPool();
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await submitVerification(42, {
      idType: "nin",
      idRef: "12345678901",
      name: "Adaeze Okafor",
      consentVersion: "rider-id-consent-v1",
    });
    expect(result.status).toBe("verified");

    const pendingWrite = pool.calls.find(
      (call) =>
        /UPDATE public\.rider_verifications/.test(call.text) &&
        call.text.includes("status = 'pending'"),
    );
    expect(pendingWrite).toBeDefined();
    // consent receipt is stamped with the submission
    expect(pendingWrite?.text).toContain("consent_captured_at");
    expect(pendingWrite?.values).toContain("rider-id-consent-v1");

    const finalWrite = pool.calls.find(
      (call) =>
        /UPDATE public\.rider_verifications/.test(call.text) &&
        call.values.includes("verified"),
    );
    expect(finalWrite).toBeDefined();
    const storedHash = finalWrite?.values.find(
      (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value),
    );
    expect(storedHash).toBe(hashIdReference("12345678901"));
    // The raw NIN must never reach the database layer.
    for (const call of pool.calls) {
      expect(call.values).not.toContain("12345678901");
    }
  });

  it("leaves an implausible name pending for human review with flags recorded (fail-closed, never auto-verified)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ score: 0.1, flags: ["pseudonym"], plausible: false }),
      ),
    );
    const pool = submissionPool();
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await submitVerification(42, {
      idType: "nin",
      idRef: "12345678901",
      name: "Mr. Dot",
      consentVersion: "rider-id-consent-v1",
    });
    expect(result.status).toBe("pending");
    const finalWrite = pool.calls.find(
      (call) =>
        /UPDATE public\.rider_verifications/.test(call.text) &&
        call.values.includes("pending"),
    );
    expect(finalWrite).toBeDefined();
    const flagsParam = finalWrite?.values.find(
      (value) => typeof value === "string" && value.includes("name_implausible"),
    );
    expect(flagsParam).toBeDefined();
  });

  it("stays pending on screening outage even with a valid ID and consent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pool = submissionPool();
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await submitVerification(42, {
      idType: "nin",
      idRef: "12345678901",
      name: "Adaeze Okafor",
      consentVersion: "rider-id-consent-v1",
    });
    expect(result.status).toBe("pending");
    const finalWrite = pool.calls.find(
      (call) =>
        /UPDATE public\.rider_verifications/.test(call.text) &&
        call.values.includes("pending"),
    );
    expect(finalWrite).toBeDefined();
    const flagsParam = finalWrite?.values.find(
      (value) =>
        typeof value === "string" && value.includes("service_unavailable"),
    );
    expect(flagsParam).toBeDefined();
  });

  it("stays pending without consent even when format and screening pass", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ score: 0.95, flags: [], plausible: true })),
    );
    const pool = submissionPool();
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await submitVerification(42, {
      idType: "nin",
      idRef: "12345678901",
      name: "Adaeze Okafor",
    });
    expect(result.status).toBe("pending");
    const finalWrite = pool.calls.find(
      (call) =>
        /UPDATE public\.rider_verifications/.test(call.text) &&
        call.values.includes("pending"),
    );
    expect(finalWrite).toBeDefined();
    const flagsParam = finalWrite?.values.find(
      (value) => typeof value === "string" && value.includes("consent_required"),
    );
    expect(flagsParam).toBeDefined();
  });

  it("rejects a too-short ID reference even with a plausible name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ score: 0.9, flags: [], plausible: true })),
    );
    const pool = submissionPool();
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await submitVerification(42, {
      idType: "nin",
      idRef: "abc",
      name: "Adaeze Okafor",
    });
    expect(result.status).toBe("rejected");
  });
});

describe("getOfferRiderBadge", () => {
  it("resolves the rider through offer -> trip -> rider_user_id and returns the badge shape", async () => {
    const pool = createPool([
      {
        match: /FROM mobility\.driver_offer o/,
        result: {
          rows: [
            {
              rider_user_id: 77,
              rider_name: "Adaeze Okafor",
              verification_status: "verified",
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const badge = await getOfferRiderBadge("11111111-1111-4111-8111-111111111111");
    expect(badge).toEqual({ verified: true, firstName: "Adaeze", rating: null });
    expect(pool.calls[0]?.values).toEqual([
      "11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("returns verified false for an unverified rider", async () => {
    const pool = createPool([
      {
        match: /FROM mobility\.driver_offer o/,
        result: {
          rows: [
            { rider_user_id: 77, rider_name: null, verification_status: null },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const badge = await getOfferRiderBadge("11111111-1111-4111-8111-111111111111");
    expect(badge).toEqual({ verified: false, firstName: null, rating: null });
  });

  it("throws NOT_FOUND for an unknown offer", async () => {
    const pool = createPool([
      { match: /FROM mobility\.driver_offer o/, result: { rows: [] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await expect(
      getOfferRiderBadge("11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("verification status hot-read cache", () => {
  it("serves repeated status reads per userId from cache (one DB read)", async () => {
    const pool = createPool([
      {
        match: /SELECT \* FROM public\.rider_verifications WHERE user_id/,
        result: {
          rows: [
            {
              id: "v-1",
              user_id: 42,
              status: "verified",
              name_screening_flags: ["reviewed"],
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const first = await getMyVerificationStatus(42);
    const second = await getMyVerificationStatus(42);
    expect(first).toEqual({ status: "verified", badgeLevel: "verified", flags: ["reviewed"] });
    expect(second).toEqual(first);
    expect(
      pool.calls.filter((call) =>
        /SELECT \* FROM public\.rider_verifications WHERE user_id/.test(call.text),
      ),
    ).toHaveLength(1);
  });

  it("submitVerification invalidates the cached status for the user", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ score: 0.95, flags: [], plausible: true })),
    );
    let status = "unverified";
    const pool = createPool([
      {
        match: /SELECT \* FROM public\.rider_verifications WHERE user_id/,
        result: {
          rows: [
            { id: "v-1", user_id: 42, status, name_screening_flags: [] },
          ],
        },
      },
      { match: /UPDATE public\.rider_verifications/, result: { rows: [], rowCount: 1 } },
      { match: /INSERT INTO public\.rider_name_screenings/, result: { rows: [], rowCount: 1 } },
    ]);
    // Recompute the SELECT row on each read so the re-read reflects the write.
    pool.query = vi.fn(async (text: string, values: unknown[] = []) => {
      pool.calls.push({ text, values });
      if (/SELECT \* FROM public\.rider_verifications WHERE user_id/.test(text)) {
        return { rows: [{ id: "v-1", user_id: 42, status, name_screening_flags: [] }] };
      }
      if (/status = 'pending'/.test(text)) {
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE public\.rider_verifications/.test(text)) {
        status = (values[1] as string) ?? status;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    dbMocks.getPool.mockResolvedValue(pool);

    const before = await getMyVerificationStatus(42); // prime cache
    expect(before.status).toBe("unverified");
    const submitted = await submitVerification(42, {
      idType: "nin",
      idRef: "12345678901",
      name: "Adaeze Okafor",
      consentVersion: "rider-id-consent-v1",
    });
    expect(submitted.status).toBe("verified");
    const after = await getMyVerificationStatus(42); // must re-read
    expect(after.status).toBe("verified");
    // SELECTs: 1 cache-priming read + 1 ensureVerificationRow inside submit +
    // 1 re-read after invalidation. Without invalidation the third read would
    // have been served stale from cache.
    expect(
      pool.calls.filter((call) =>
        /SELECT \* FROM public\.rider_verifications WHERE user_id/.test(call.text),
      ),
    ).toHaveLength(3);
  });
});

describe("screenName FAIL_OPEN_FAST wiring", () => {
  it("fails fast (~0ms, no HTTP) once the shared breaker opens after 2 failures", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("connection refused");
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const first = await screenName("Adaeze Okafor");
    const second = await screenName("Adaeze Okafor");
    expect(first.unavailable).toBe(true);
    expect(second.unavailable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const startedAt = Date.now();
    const third = await screenName("Adaeze Okafor");
    expect(Date.now() - startedAt).toBeLessThan(50);
    expect(third).toEqual({
      score: null,
      flags: ["service_unavailable"],
      plausible: false,
      unavailable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2); // breaker open: no HTTP attempt
  });
});
