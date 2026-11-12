import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getPool: vi.fn(),
}));

vi.mock("../server/db", () => dbMocks);

import {
  addCartItemInputSchema,
  checkoutConsumerCart,
  checkoutInputSchema,
  computePlatformFeeMinor,
  consumerIdempotencyKeySchema,
  generateShareCode,
  joinGroupOrderInputSchema,
  minorToMajorString,
  rateConsumerOrder,
  rateOrderInputSchema,
  resolveConsumerFeeConfig,
  subscribePlanInputSchema,
} from "./_core/consumerCommerce";

type QueryResult = { rows: unknown[]; rowCount?: number };

function createPool(handlers: Array<{ match: RegExp; result: QueryResult | (() => QueryResult); error?: { code: string; message: string } }>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      const handler = handlers.find((candidate) => candidate.match.test(text));
      if (!handler) return { rows: [], rowCount: 0 };
      if (handler.error) {
        const err = new Error(handler.error.message) as Error & { code: string };
        err.code = handler.error.code;
        throw err;
      }
      return typeof handler.result === "function" ? handler.result() : handler.result;
    }),
  };
}

function jsonResponse(status: number, body = "{}"): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

const CHECKOUT_INPUT = {
  consumerUserId: 42,
  cartId: "11111111-1111-4111-8111-111111111111",
  idempotencyKey: "checkout-key-0001",
  deliveryAddress: "12 Marina Road, Lagos",
  deliveryLat: 6.5243793,
  deliveryLng: 3.3792057,
  notes: null,
};

const SESSION_ID = "22222222-2222-4222-8222-222222222222";

const FRESH_CHECKOUT_RESULT = {
  order_id: 7,
  order_number: "SO-1007",
  checkout_session_id: SESSION_ID,
  status: "open",
  subtotal_minor: 660000,
  platform_fee_minor: 33000,
  delivery_fee_minor: 50000,
  total_minor: 743000,
  currency: "NGN",
  expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  replayed: false,
};

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("minorToMajorString", () => {
  it("converts minor units to exact 2-decimal major strings with no float drift", () => {
    expect(minorToMajorString(660000)).toBe("6600.00");
    expect(minorToMajorString(5)).toBe("0.05");
    expect(minorToMajorString(0)).toBe("0.00");
    expect(minorToMajorString(100000000)).toBe("1000000.00");
    expect(minorToMajorString(743000)).toBe("7430.00");
    expect(minorToMajorString(99)).toBe("0.99");
  });

  it("rejects negative amounts", () => {
    expect(() => minorToMajorString(-1)).toThrow("negative_minor_units_not_supported");
  });
});

describe("computePlatformFeeMinor", () => {
  it("is integer-exact (floor of subtotal * bps / 10000)", () => {
    expect(computePlatformFeeMinor(660000, 500)).toBe(33000);
    expect(computePlatformFeeMinor(5, 500)).toBe(0);
    expect(computePlatformFeeMinor(999, 100)).toBe(9);
    expect(computePlatformFeeMinor(0, 3000)).toBe(0);
    expect(computePlatformFeeMinor(123456789, 275)).toBe(3395061);
  });
});

describe("resolveConsumerFeeConfig", () => {
  it("falls back to defaults when unset", () => {
    expect(resolveConsumerFeeConfig({})).toEqual({
      platformFeeBps: 500,
      deliveryFeeMinor: 50000,
    });
  });

  it("clamps bps to 0..3000 and delivery fee to >= 0", () => {
    expect(
      resolveConsumerFeeConfig({
        consumerPlatformFeeBps: "5000",
        consumerDeliveryFeeMinor: "-10",
      }),
    ).toEqual({ platformFeeBps: 3000, deliveryFeeMinor: 0 });
    expect(
      resolveConsumerFeeConfig({
        consumerPlatformFeeBps: "-5",
        consumerDeliveryFeeMinor: "75000",
      }),
    ).toEqual({ platformFeeBps: 0, deliveryFeeMinor: 75000 });
  });

  it("falls back on unparsable values", () => {
    expect(
      resolveConsumerFeeConfig({
        consumerPlatformFeeBps: "abc",
        consumerDeliveryFeeMinor: "",
      }),
    ).toEqual({ platformFeeBps: 500, deliveryFeeMinor: 50000 });
  });
});

describe("generateShareCode", () => {
  it("emits 8-char Crockford-ish codes (no I, L, O, U)", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateShareCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    }
  });
});

describe("zod input validation", () => {
  it("enforces the platform idempotency-key format", () => {
    expect(consumerIdempotencyKeySchema.safeParse("checkout-key-0001").success).toBe(true);
    expect(consumerIdempotencyKeySchema.safeParse("short").success).toBe(false);
    expect(consumerIdempotencyKeySchema.safeParse("-badstart0").success).toBe(false);
    expect(consumerIdempotencyKeySchema.safeParse("has space in it").success).toBe(false);
    expect(consumerIdempotencyKeySchema.safeParse("a".repeat(129)).success).toBe(false);
  });

  it("validates checkout coordinates and address", () => {
    const base = {
      cartId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "checkout-key-0001",
      deliveryAddress: "12 Marina Road, Lagos",
      deliveryLat: 6.5243793,
      deliveryLng: 3.3792057,
    };
    expect(checkoutInputSchema.safeParse(base).success).toBe(true);
    expect(checkoutInputSchema.safeParse({ ...base, deliveryLat: 91 }).success).toBe(false);
    expect(checkoutInputSchema.safeParse({ ...base, deliveryLng: -181 }).success).toBe(false);
    expect(checkoutInputSchema.safeParse({ ...base, deliveryAddress: "ab" }).success).toBe(false);
  });

  it("caps cart item quantity at 999 and rejects negative prices", () => {
    const base = {
      cartId: "11111111-1111-4111-8111-111111111111",
      name: "Jollof rice",
      unitPriceMinor: 250000,
      quantity: 2,
    };
    expect(addCartItemInputSchema.safeParse(base).success).toBe(true);
    expect(addCartItemInputSchema.safeParse({ ...base, quantity: 1000 }).success).toBe(false);
    expect(addCartItemInputSchema.safeParse({ ...base, quantity: 0 }).success).toBe(false);
    expect(addCartItemInputSchema.safeParse({ ...base, unitPriceMinor: -1 }).success).toBe(false);
  });

  it("normalizes group-order share codes to upper case", () => {
    const parsed = joinGroupOrderInputSchema.safeParse({ shareCode: "ab12cd34" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.shareCode).toBe("AB12CD34");
    expect(joinGroupOrderInputSchema.safeParse({ shareCode: "AB12CD3" }).success).toBe(false);
    expect(joinGroupOrderInputSchema.safeParse({ shareCode: "AB12CD3O" }).success).toBe(false);
  });

  it("requires 1..5 ratings for order reviews", () => {
    const base = {
      orderId: 7,
      overallRating: 5,
      punctualityRating: 4,
      professionalismRating: 5,
      vehicleConditionRating: 4,
      communicationRating: 5,
    };
    expect(rateOrderInputSchema.safeParse(base).success).toBe(true);
    expect(rateOrderInputSchema.safeParse({ ...base, overallRating: 0 }).success).toBe(false);
    expect(rateOrderInputSchema.safeParse({ ...base, communicationRating: 6 }).success).toBe(false);
    expect(subscribePlanInputSchema.safeParse({ planId: 1, idempotencyKey: "sub-key-0001" }).success).toBe(true);
  });
});

describe("checkoutConsumerCart", () => {
  it("passes env-derived integer fees to consumer_checkout and returns payment_pending on initiation success", async () => {
    const pool = createPool([
      { match: /SUM\(unit_price_minor/, result: { rows: [{ subtotal: "660000" }] } },
      { match: /SELECT public\.consumer_checkout\(/, result: { rows: [{ result: FRESH_CHECKOUT_RESULT }] } },
      { match: /FROM public\.consumer_checkout_sessions/, result: { rows: [{ status: "open", payment_reference: null, mojaloop_transfer_id: null }] } },
      { match: /consumer_processed_events/, result: { rows: [], rowCount: 0 } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, '{"status":"accepted"}')));

    const result = await checkoutConsumerCart(CHECKOUT_INPUT);

    expect(result.status).toBe("payment_pending");
    expect(result.paymentReference).toBe(`cp-${SESSION_ID}`);
    expect(result.mojaloopTransferId).toBe(`ct-${SESSION_ID}`);
    expect(result.totalMinor).toBe(743000);
    expect(result.replayed).toBe(false);

    // consumer_checkout received the fee pair computed from the subtotal
    // (500 bps of 660000 = 33000, flat 50000 delivery fee).
    const fnCall = pool.calls.find((c) => /public\.consumer_checkout\(/.test(c.text));
    expect(fnCall?.values[7]).toBe(33000);
    expect(fnCall?.values[8]).toBe(50000);

    // Quote then transfer were initiated through fetch, then the session was
    // updated and the processed-events dedupe anchor recorded.
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/quotes/request");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/transfers/initiate");
    expect(pool.calls.some((c) => /status = 'payment_pending'/.test(c.text))).toBe(true);
    expect(pool.calls.some((c) => /INSERT INTO public\.consumer_processed_events/.test(c.text))).toBe(true);
  });

  it("returns the stored result on same-key replay without re-initiating payment", async () => {
    const pool = createPool([
      { match: /SUM\(unit_price_minor/, result: { rows: [{ subtotal: "660000" }] } },
      {
        match: /SELECT public\.consumer_checkout\(/,
        result: {
          rows: [{ result: { ...FRESH_CHECKOUT_RESULT, status: "payment_pending", replayed: true } }],
        },
      },
      {
        match: /FROM public\.consumer_checkout_sessions/,
        result: {
          rows: [{ status: "payment_pending", payment_reference: `cp-${SESSION_ID}`, mojaloop_transfer_id: `ct-${SESSION_ID}` }],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkoutConsumerCart(CHECKOUT_INPUT);

    expect(result.replayed).toBe(true);
    expect(result.status).toBe("payment_pending");
    expect(result.orderNumber).toBe("SO-1007");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pool.calls.some((c) => /status = 'payment_pending'/.test(c.text))).toBe(false);
  });

  it("maps a same-key/different-params replay (22023) to BAD_REQUEST", async () => {
    const pool = createPool([
      { match: /SUM\(unit_price_minor/, result: { rows: [{ subtotal: "660000" }] } },
      {
        match: /SELECT public\.consumer_checkout\(/,
        result: { rows: [] },
        error: { code: "22023", message: "idempotency key replay with different parameters" },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await expect(checkoutConsumerCart(CHECKOUT_INPUT)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "idempotency key replay with different parameters",
    });
  });

  it("maps ownership/state errors: 42501 FORBIDDEN, P0002 NOT_FOUND, 55000 CONFLICT", async () => {
    for (const [pgCode, trpcCode] of [
      ["42501", "FORBIDDEN"],
      ["P0002", "NOT_FOUND"],
      ["55000", "CONFLICT"],
    ] as const) {
      const pool = createPool([
        { match: /SUM\(unit_price_minor/, result: { rows: [{ subtotal: "0" }] } },
        { match: /SELECT public\.consumer_checkout\(/, result: { rows: [] }, error: { code: pgCode, message: `pg_${pgCode}` } },
      ]);
      dbMocks.getPool.mockResolvedValue(pool);
      await expect(checkoutConsumerCart(CHECKOUT_INPUT)).rejects.toMatchObject({ code: trpcCode });
    }
  });

  it("keeps the session open and throws payment_initiation_failed when the payment service fails", async () => {
    const pool = createPool([
      { match: /SUM\(unit_price_minor/, result: { rows: [{ subtotal: "660000" }] } },
      { match: /SELECT public\.consumer_checkout\(/, result: { rows: [{ result: FRESH_CHECKOUT_RESULT }] } },
      { match: /FROM public\.consumer_checkout_sessions/, result: { rows: [{ status: "open", payment_reference: null, mojaloop_transfer_id: null }] } },
      { match: /consumer_processed_events/, result: { rows: [], rowCount: 0 } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    // resilientFetch returns a terminal 5xx after its retry budget.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500)));

    await expect(checkoutConsumerCart(CHECKOUT_INPUT)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "payment_initiation_failed",
    });
    // The session must NOT have been marked payment_pending and no dedupe
    // row recorded — the same idempotency key can resume this checkout.
    expect(pool.calls.some((c) => /status = 'payment_pending'/.test(c.text))).toBe(false);
    expect(pool.calls.some((c) => /INSERT INTO public\.consumer_processed_events/.test(c.text))).toBe(false);
  });
});

describe("rateConsumerOrder", () => {
  const RATING_INPUT = {
    consumerUserId: 42,
    orderId: 7,
    overallRating: 5,
    punctualityRating: 4,
    professionalismRating: 5,
    vehicleConditionRating: 4,
    communicationRating: 5,
    feedback: "Great delivery",
  };

  it("rejects orders not owned by the caller", async () => {
    const pool = createPool([{ match: /FROM public\.orders/, result: { rows: [] } }]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(rateConsumerOrder(RATING_INPUT)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "order_not_found_for_consumer",
    });
  });

  it("rejects orders without a driver or not yet delivered", async () => {
    const noDriver = createPool([
      { match: /FROM public\.orders/, result: { rows: [{ id: 7, driver_id: null, status: "delivered" }] } },
    ]);
    dbMocks.getPool.mockResolvedValue(noDriver);
    await expect(rateConsumerOrder(RATING_INPUT)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "order_has_no_driver",
    });

    const notDelivered = createPool([
      { match: /FROM public\.orders/, result: { rows: [{ id: 7, driver_id: 3, status: "in_transit" }] } },
    ]);
    dbMocks.getPool.mockResolvedValue(notDelivered);
    await expect(rateConsumerOrder(RATING_INPUT)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "order_not_delivered",
    });
  });

  it("inserts driver_reviews and maps the UNIQUE(order_id) collision to order_already_rated", async () => {
    const conflicted = createPool([
      { match: /FROM public\.orders/, result: { rows: [{ id: 7, driver_id: 3, status: "delivered" }] } },
      { match: /INSERT INTO public\.driver_reviews/, result: { rows: [], rowCount: 0 } },
    ]);
    dbMocks.getPool.mockResolvedValue(conflicted);
    await expect(rateConsumerOrder(RATING_INPUT)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "order_already_rated",
    });

    const fresh = createPool([
      { match: /FROM public\.orders/, result: { rows: [{ id: 7, driver_id: 3, status: "delivered" }] } },
      { match: /INSERT INTO public\.driver_reviews/, result: { rows: [{ id: 11 }] } },
    ]);
    dbMocks.getPool.mockResolvedValue(fresh);
    await expect(rateConsumerOrder(RATING_INPUT)).resolves.toEqual({
      reviewId: 11,
      orderId: 7,
      driverId: 3,
    });
    const insert = fresh.calls.find((c) => /driver_reviews/.test(c.text));
    expect(insert?.values.slice(3, 8)).toEqual([5, 4, 5, 4, 5]);
  });
});

describe("drizzle/0104_consumer_commerce_core.sql (static contract)", () => {
  const migration = readFileSync(
    join(process.cwd(), "drizzle", "0104_consumer_commerce_core.sql"),
    "utf8",
  );
  const seeds = readFileSync(
    join(process.cwd(), "scripts", "init-local-postgres.sql"),
    "utf8",
  );

  it("is SECURITY DEFINER with a pinned search_path", () => {
    expect(migration).toContain("SECURITY DEFINER SET search_path = pg_catalog, public");
  });

  it("generates order numbers in the seed 'SO-<number>' convention", () => {
    expect(migration).toMatch(/'SO-' \|\| \(1000 \+ nextval\(pg_get_serial_sequence\('public\.orders', 'id'\)\)/);
    // Seed convention sanity: existing seeds use SO-1001 / SO-1002.
    const seedNumber = seeds.match(/'(SO-\d+)'/);
    expect(seedNumber?.[1]).toMatch(/^SO-\d+$/);
    expect(seedNumber?.[1]).toBe("SO-1001");
  });

  it("converts minor units to legacy varchar major units with integer math only", () => {
    expect(migration).toContain(
      "(v_total_minor / 100)::bigint::text || '.' || lpad((v_total_minor % 100)::text, 2, '0')",
    );
    expect(migration).not.toMatch(/::numeric\s*\(\s*v_/);
  });

  it("raises 22023 on same-key replay with different parameters", () => {
    expect(migration).toContain(
      "RAISE EXCEPTION 'idempotency key replay with different parameters' USING ERRCODE = '22023'",
    );
  });
});
