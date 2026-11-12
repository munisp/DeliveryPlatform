import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P3-M merchant self-serve tests. The DB is mocked at the pool boundary
 * (consumer-commerce.test.ts pattern): getPool returns a handler-table pool
 * whose connect() yields a client sharing the same dispatcher, so BEGIN /
 * COMMIT / ROLLBACK and multi-statement transactions are exercised verbatim.
 * Medusa is mocked at the resilientFetch boundary; merchantCommerce's
 * createMerchantProduct is mocked so the wrapper is tested without the
 * Medusa write path.
 */

const dbMocks = vi.hoisted(() => ({ getPool: vi.fn() }));
const gatewayMocks = vi.hoisted(() => ({ resilientFetch: vi.fn() }));
const commerceMocks = vi.hoisted(() => ({ createMerchantProduct: vi.fn() }));

vi.mock("../server/db", () => dbMocks);
vi.mock("../server/_core/resilientFetch", () => gatewayMocks);
vi.mock("../server/_core/merchantCommerce", () => commerceMocks);
vi.mock("../server/_core/env", () => ({
  ENV: {
    medusaMerchantApiUrl: "https://medusa.test",
    medusaMerchantApiToken: "test-token",
  },
}));

import {
  getMyEarnings,
  listMyFulfillmentRequests,
  merchantSignup,
  merchantSignupInputSchema,
  projectProviderCatalog,
  syncProviderCatalog,
  transitionMyFulfillment,
  updateStorefrontProfile,
  createMerchantProductWithProjection,
} from "./_core/merchantSelfServe";

type QueryResult = { rows: unknown[]; rowCount?: number };
type Handler = {
  match: RegExp;
  result?: QueryResult | (() => QueryResult);
  error?: { code: string; message: string };
};

function createPool(handlers: Handler[]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const dispatch = async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    const handler = handlers.find((candidate) => candidate.match.test(text));
    if (!handler) return { rows: [], rowCount: 0 };
    if (handler.error) {
      const err = new Error(handler.error.message) as Error & { code: string };
      err.code = handler.error.code;
      throw err;
    }
    return typeof handler.result === "function" ? handler.result() : handler.result ?? { rows: [] };
  };
  const client = { query: vi.fn(dispatch), release: vi.fn() };
  return {
    calls,
    client,
    query: vi.fn(dispatch),
    connect: vi.fn(async () => client),
  };
}

function medusaProductResponse(product: unknown): Response {
  return new Response(JSON.stringify({ product }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SIGNUP_INPUT = {
  actorUserId: 42,
  legalName: "Mama Put Ventures Ltd",
  displayName: "Mama Put Kitchen",
  address: "12 Marina Road, Lagos",
  latitude: 6.5243793,
  longitude: 3.3792057,
  idempotencyKey: "signup-key-0001",
};

const FULFILLMENT_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("merchantSignup", () => {
  it("replays from the ledger without touching the database further", async () => {
    const pool = createPool([
      {
        match: /FROM public\.consumer_processed_events/,
        result: {
          rows: [
            {
              result_json: {
                provider_id: 77,
                onboarding_state: "verification_pending",
                medusa_store_id: "dp-store-77",
              },
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const result = await merchantSignup(SIGNUP_INPUT);
    expect(result).toEqual({
      providerId: 77,
      onboardingState: "verification_pending",
      medusaStoreId: "dp-store-77",
      replayed: true,
      existingPortal: false,
    });
    // Ledger event_id is actor-scoped.
    expect(pool.calls[0].values[2]).toBe("42:signup-key-0001");
    // No transaction / insert happened.
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("creates provider + portal transactionally on the fresh path", async () => {
    const pool = createPool([
      { match: /FROM public\.consumer_processed_events/, result: { rows: [] } },
      { match: /FROM commerce\.merchant_portal p/, result: { rows: [] } },
      { match: /FROM public\.service_verticals/, result: { rows: [{ id: 1 }] } },
      {
        match: /SELECT email, phone FROM public\.users/,
        result: { rows: [{ email: "owner@mamaput.ng", phone: "+2348000000000" }] },
      },
      { match: /INSERT INTO public\.service_providers/, result: { rows: [{ id: 88 }] } },
      {
        match: /commerce\.begin_merchant_onboarding/,
        result: { rows: [{ state: "verification_pending" }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const result = await merchantSignup(SIGNUP_INPUT);
    expect(result).toEqual({
      providerId: 88,
      onboardingState: "verification_pending",
      medusaStoreId: "dp-store-88",
      replayed: false,
      existingPortal: false,
    });

    const texts = pool.calls.map((c) => c.text);
    expect(texts[0]).toMatch(/FROM public\.consumer_processed_events/);
    expect(texts).toContain("BEGIN");
    expect(texts[texts.length - 1]).toBe("COMMIT");

    const insert = pool.calls.find((c) => /INSERT INTO public\.service_providers/.test(c.text));
    expect(insert).toBeDefined();
    // pending/pending onboarding statuses; contact falls back to the user row.
    expect(insert!.text).toContain("'pending','pending'");
    expect(insert!.values[1]).toBe("Mama Put Kitchen");
    expect(insert!.values[2]).toBe("Mama Put Ventures Ltd");
    expect(insert!.values[3]).toBe("owner@mamaput.ng");
    expect(insert!.values[4]).toBe("+2348000000000");

    const onboarding = pool.calls.find((c) => /begin_merchant_onboarding/.test(c.text));
    expect(onboarding!.values[1]).toBe(88);
    expect(onboarding!.values[4]).toBe("dp-store-88");
    expect(onboarding!.values[5]).toBe("signup-key-0001");
  });

  it("returns the existing portal without inserting when the actor already owns one", async () => {
    const pool = createPool([
      { match: /FROM public\.consumer_processed_events/, result: { rows: [] } },
      {
        match: /FROM commerce\.merchant_portal p/,
        result: { rows: [{ provider_id: 55, state: "active", medusa_store_id: "store-x" }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const result = await merchantSignup({ ...SIGNUP_INPUT, idempotencyKey: "signup-key-0002" });
    expect(result).toEqual({
      providerId: 55,
      onboardingState: "active",
      medusaStoreId: "store-x",
      replayed: true,
      existingPortal: true,
    });
    expect(pool.calls.some((c) => /INSERT INTO public\.service_providers/.test(c.text))).toBe(false);
  });

  it("fails closed when no active vertical exists", async () => {
    const pool = createPool([
      { match: /FROM public\.consumer_processed_events/, result: { rows: [] } },
      { match: /FROM commerce\.merchant_portal p/, result: { rows: [] } },
      { match: /FROM public\.service_verticals/, result: { rows: [] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(merchantSignup(SIGNUP_INPUT)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "vertical_required",
    });
    expect(pool.calls).toContainEqual(expect.objectContaining({ text: "ROLLBACK" }));
  });

  it("rejects invalid idempotency keys at the schema boundary", () => {
    expect(() =>
      merchantSignupInputSchema.parse({ ...SIGNUP_INPUT, idempotencyKey: "bad key!" }),
    ).toThrow();
    expect(() =>
      merchantSignupInputSchema.parse({ ...SIGNUP_INPUT, idempotencyKey: "ok-key_1.2:3" }),
    ).not.toThrow();
  });
});

describe("catalog projection", () => {
  const MAPPINGS = {
    match: /FROM commerce\.merchant_catalog_product/,
    result: {
      rows: [
        { medusa_product_id: "prod_123", product_handle: "jollof-rice", state: "published" },
      ],
    },
  };
  const AUTHORIZE = {
    match: /commerce\.authorize_merchant_portal/,
    result: {
      rows: [
        {
          provider_id: 7,
          medusa_store_id: "store-1",
          default_stock_location_id: null,
          payment_enabled: true,
          settlement_fsp_alias: "fsp",
          currency_code: "NGN",
        },
      ],
    },
  };

  it("upserts into provider_catalog_items with exact integer string price math", async () => {
    const pool = createPool([AUTHORIZE, MAPPINGS, { match: /INSERT INTO public\.provider_catalog_items/, result: { rows: [] } }]);
    dbMocks.getPool.mockResolvedValue(pool);
    gatewayMocks.resilientFetch.mockResolvedValue(
      medusaProductResponse({
        id: "prod_123",
        handle: "jollof-rice",
        title: "Jollof Rice",
        description: "Smoky party jollof",
        status: "published",
        variants: [{ prices: [{ currency_code: "ngn", amount: 660000 }] }],
      }),
    );
    const result = await projectProviderCatalog({ actorUserId: 42, providerId: 7 });
    expect(result.projected).toBe(1);
    expect(result.items[0]).toMatchObject({
      sku: "prod_123",
      itemName: "Jollof Rice",
      price: "6600.00",
      currency: "NGN",
      isAvailable: true,
    });
    const upsert = pool.calls.find((c) => /INSERT INTO public\.provider_catalog_items/.test(c.text));
    expect(upsert!.text).toContain("ON CONFLICT (provider_id, sku) DO UPDATE");
    expect(upsert!.values[1]).toBe("prod_123");
    expect(upsert!.values[4]).toBe("6600.00");
    expect(upsert!.values[6]).toBe(true);
  });

  it("marks non-published products unavailable and formats sub-naira prices exactly", async () => {
    const pool = createPool([AUTHORIZE, MAPPINGS, { match: /INSERT INTO public\.provider_catalog_items/, result: { rows: [] } }]);
    dbMocks.getPool.mockResolvedValue(pool);
    gatewayMocks.resilientFetch.mockResolvedValue(
      medusaProductResponse({
        id: "prod_123",
        title: "Jollof Rice",
        status: "draft",
        variants: [{ prices: [{ currency_code: "ngn", amount: 5 }] }],
      }),
    );
    const result = await projectProviderCatalog({ actorUserId: 42, providerId: 7 });
    expect(result.items[0].price).toBe("0.05");
    expect(result.items[0].isAvailable).toBe(false);
  });

  it("skips products with no Medusa price variant and counts Medusa read failures", async () => {
    const pool = createPool([
      AUTHORIZE,
      {
        match: /FROM commerce\.merchant_catalog_product/,
        result: {
          rows: [
            { medusa_product_id: "prod_no_price", product_handle: "a", state: "published" },
            { medusa_product_id: "prod_gone", product_handle: "b", state: "published" },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    gatewayMocks.resilientFetch
      .mockResolvedValueOnce(
        medusaProductResponse({ id: "prod_no_price", title: "No Price", status: "published", variants: [] }),
      )
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));
    const result = await syncProviderCatalog({ actorUserId: 42, providerId: 7 });
    expect(result.skipped).toBe(1);
    expect(result.failed).toEqual(["prod_gone"]);
    expect(result.projected).toBe(0);
  });

  it("refuses non-members via the portal role check (42501 → FORBIDDEN)", async () => {
    const pool = createPool([
      {
        match: /commerce\.authorize_merchant_portal/,
        error: { code: "42501", message: "merchant access denied" },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      projectProviderCatalog({ actorUserId: 999, providerId: 7 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns NOT_FOUND when the requested product is not mapped to the provider", async () => {
    const pool = createPool([AUTHORIZE, { match: /FROM commerce\.merchant_catalog_product/, result: { rows: [] } }]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      projectProviderCatalog({ actorUserId: 42, providerId: 7, medusaProductId: "prod_nope" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("createMerchantProductWithProjection projects the new product and survives projection failure", async () => {
    commerceMocks.createMerchantProduct.mockResolvedValue({
      productId: "prod_new",
      handle: "peppered-chicken",
      state: "published",
    });
    const pool = createPool([
      AUTHORIZE,
      {
        match: /FROM commerce\.merchant_catalog_product/,
        result: { rows: [{ medusa_product_id: "prod_new", product_handle: "peppered-chicken", state: "published" }] },
      },
      { match: /INSERT INTO public\.provider_catalog_items/, result: { rows: [] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    gatewayMocks.resilientFetch.mockResolvedValue(
      medusaProductResponse({
        id: "prod_new",
        title: "Peppered Chicken",
        status: "published",
        variants: [{ prices: [{ currency_code: "ngn", amount: 250000 }] }],
      }),
    );
    const ok = await createMerchantProductWithProjection({
      actorUserId: 42,
      providerId: 7,
      title: "Peppered Chicken",
      handle: "peppered-chicken",
      description: "Hot",
      status: "published",
      currencyCode: "NGN",
      priceMinor: 250000,
      sku: "PC-1",
      imageUrls: [],
      idempotencyKey: "product-key-0001",
    });
    expect(ok.projectionError).toBeNull();
    expect(ok.projection?.items[0]?.price).toBe("2500.00");

    // Projection failure is reported, not thrown (syncCatalog repairs).
    commerceMocks.createMerchantProduct.mockResolvedValue({
      productId: "prod_new2",
      handle: "peppered-chicken-2",
      state: "draft",
    });
    const failingPool = createPool([
      { match: /commerce\.authorize_merchant_portal/, error: { code: "23514", message: "active merchant required" } },
    ]);
    dbMocks.getPool.mockResolvedValue(failingPool);
    const degraded = await createMerchantProductWithProjection({
      actorUserId: 42,
      providerId: 7,
      title: "Peppered Chicken 2",
      handle: "peppered-chicken-2",
      description: "Hot",
      status: "draft",
      currencyCode: "NGN",
      priceMinor: 250000,
      sku: "PC-2",
      imageUrls: [],
      idempotencyKey: "product-key-0002",
    });
    expect(degraded.projection).toBeNull();
    expect(degraded.projectionError).toBe("active merchant required");
  });
});

describe("myFulfillmentRequests", () => {
  it("reads merchant-scoped requests pinned to the authorized provider", async () => {
    const pool = createPool([
      {
        match: /commerce\.authorize_merchant_portal/,
        result: { rows: [{ provider_id: 7, medusa_store_id: "s", default_stock_location_id: null, payment_enabled: false, settlement_fsp_alias: null, currency_code: "NGN" }] },
      },
      {
        match: /ORDER BY requested_at DESC/,
        result: {
          rows: [
            {
              id: FULFILLMENT_ID,
              provider_id: 7,
              medusa_order_id: "order_1",
              state: "requested",
              delivery_order_id: null,
              delivery_reference: null,
              failure_reason: null,
              requested_at: "2026-11-12T10:00:00Z",
              accepted_at: null,
              updated_at: "2026-11-12T10:00:00Z",
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const rows = await listMyFulfillmentRequests({ actorUserId: 42, providerId: 7, status: "requested", limit: 25 });
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("requested");
    const list = pool.calls.find((c) => /ORDER BY requested_at DESC/.test(c.text));
    expect(list!.values[0]).toBe(7);
    expect(list!.values[1]).toBe("requested");
    expect(list!.values[2]).toBe(25);
  });

  it("never reaches the list query when portal authorization fails", async () => {
    const pool = createPool([
      { match: /commerce\.authorize_merchant_portal/, error: { code: "42501", message: "merchant access denied" } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      listMyFulfillmentRequests({ actorUserId: 999, providerId: 7 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(pool.calls.some((c) => /ORDER BY requested_at DESC/.test(c.text))).toBe(false);
  });
});

describe("transitionMyFulfillment", () => {
  const LOCK = {
    match: /FOR UPDATE/,
    result: { rows: [{ id: FULFILLMENT_ID, provider_id: 7, state: "requested" }] },
  };
  const AUTHORIZE = {
    match: /commerce\.authorize_merchant_portal/,
    result: { rows: [{ provider_id: 7, medusa_store_id: "s", default_stock_location_id: null, payment_enabled: false, settlement_fsp_alias: null, currency_code: "NGN" }] },
  };
  const NO_REPLAY = { match: /SELECT 1 FROM commerce\.fulfillment_event/, result: { rows: [] } };
  const SEQUENCE = { match: /max\(sequence_no\)/, result: { rows: [{ next: 2 }] } };

  it("accepts a requested fulfillment (state update + sequenced event)", async () => {
    const pool = createPool([LOCK, AUTHORIZE, NO_REPLAY, SEQUENCE]);
    dbMocks.getPool.mockResolvedValue(pool);
    const result = await transitionMyFulfillment({
      actorUserId: 42,
      fulfillmentId: FULFILLMENT_ID,
      action: "accept",
      idempotencyKey: "accept-key-0001",
    });
    expect(result).toEqual({
      fulfillmentId: FULFILLMENT_ID,
      providerId: 7,
      previousState: "requested",
      state: "accepted",
      replayed: false,
    });
    const update = pool.calls.find((c) => /UPDATE commerce\.fulfillment_request/.test(c.text));
    expect(update!.values[1]).toBe("accepted");
    const event = pool.calls.find((c) => /INSERT INTO commerce\.fulfillment_event/.test(c.text));
    expect(event!.values[3]).toBe("commerce.fulfillment.accepted");
    expect(event!.values[7]).toBe("accept-key-0001");
    expect(pool.calls[pool.calls.length - 1].text).toBe("COMMIT");
  });

  it("rejects a requested fulfillment into cancelled with the reason in event detail", async () => {
    const pool = createPool([LOCK, AUTHORIZE, NO_REPLAY, SEQUENCE]);
    dbMocks.getPool.mockResolvedValue(pool);
    const result = await transitionMyFulfillment({
      actorUserId: 42,
      fulfillmentId: FULFILLMENT_ID,
      action: "reject",
      reason: "Out of stock",
      idempotencyKey: "reject-key-0001",
    });
    expect(result.state).toBe("cancelled");
    const event = pool.calls.find((c) => /INSERT INTO commerce\.fulfillment_event/.test(c.text));
    expect(event!.values[3]).toBe("commerce.fulfillment.cancelled");
    expect(JSON.parse(String(event!.values[6]))).toEqual({ action: "reject", reason: "Out of stock" });
  });

  it("records ready as an evidence-only event without a state change", async () => {
    const pool = createPool([
      { ...LOCK, result: { rows: [{ id: FULFILLMENT_ID, provider_id: 7, state: "accepted" }] } },
      AUTHORIZE,
      NO_REPLAY,
      SEQUENCE,
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const result = await transitionMyFulfillment({
      actorUserId: 42,
      fulfillmentId: FULFILLMENT_ID,
      action: "ready",
      idempotencyKey: "ready-key-00001",
    });
    expect(result.state).toBe("accepted");
    expect(pool.calls.some((c) => /UPDATE commerce\.fulfillment_request/.test(c.text))).toBe(false);
    const event = pool.calls.find((c) => /INSERT INTO commerce\.fulfillment_event/.test(c.text));
    expect(event!.values[3]).toBe("commerce.fulfillment.ready");
    expect(event!.values[4]).toBe("accepted");
    expect(event!.values[5]).toBe("accepted");
  });

  it("refuses illegal edges with CONFLICT", async () => {
    const pool = createPool([
      { ...LOCK, result: { rows: [{ id: FULFILLMENT_ID, provider_id: 7, state: "delivered" }] } },
      AUTHORIZE,
      NO_REPLAY,
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      transitionMyFulfillment({
        actorUserId: 42,
        fulfillmentId: FULFILLMENT_ID,
        action: "accept",
        idempotencyKey: "accept-key-0002",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "invalid_fulfillment_transition" });
    expect(pool.calls.some((c) => c.text === "ROLLBACK")).toBe(true);
  });

  it("enforces provider ownership (another merchant's request → FORBIDDEN)", async () => {
    const pool = createPool([
      LOCK,
      { match: /commerce\.authorize_merchant_portal/, error: { code: "42501", message: "merchant access denied" } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      transitionMyFulfillment({
        actorUserId: 999,
        fulfillmentId: FULFILLMENT_ID,
        action: "accept",
        idempotencyKey: "accept-key-0003",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(pool.calls.some((c) => /UPDATE commerce\.fulfillment_request/.test(c.text))).toBe(false);
  });

  it("replays an already-recorded idempotency key without changing state", async () => {
    const pool = createPool([
      LOCK,
      AUTHORIZE,
      { match: /SELECT 1 FROM commerce\.fulfillment_event/, result: { rows: [{ "?column?": 1 }] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const result = await transitionMyFulfillment({
      actorUserId: 42,
      fulfillmentId: FULFILLMENT_ID,
      action: "accept",
      idempotencyKey: "accept-key-0001",
    });
    expect(result.replayed).toBe(true);
    expect(result.state).toBe("requested");
    expect(pool.calls.some((c) => /UPDATE commerce\.fulfillment_request/.test(c.text))).toBe(false);
    expect(pool.calls.some((c) => /INSERT INTO commerce\.fulfillment_event/.test(c.text))).toBe(false);
  });

  it("returns NOT_FOUND for an unknown fulfillment id", async () => {
    const pool = createPool([{ match: /FOR UPDATE/, result: { rows: [] } }]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      transitionMyFulfillment({
        actorUserId: 42,
        fulfillmentId: FULFILLMENT_ID,
        action: "accept",
        idempotencyKey: "accept-key-0004",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("myEarnings", () => {
  it("aggregates orders, fulfillments and payout presence without leaking references", async () => {
    const pool = createPool([
      {
        match: /commerce\.authorize_merchant_portal/,
        result: { rows: [{ provider_id: 7, medusa_store_id: "s", default_stock_location_id: null, payment_enabled: true, settlement_fsp_alias: "secret-alias", currency_code: "NGN" }] },
      },
      {
        match: /FROM public\.orders/,
        result: { rows: [{ order_count: "12", delivered_count: "9", gross_delivered_major: "45600.00" }] },
      },
      {
        match: /GROUP BY state/,
        result: { rows: [{ state: "requested", count: "2" }, { state: "delivered", count: "8" }] },
      },
      { match: /merchant_payment_configuration/, result: { rows: [{ configured: true }] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const earnings = await getMyEarnings({ actorUserId: 42, providerId: 7 });
    expect(earnings).toEqual({
      providerId: 7,
      orderCount: 12,
      deliveredOrderCount: 9,
      grossDeliveredMajor: "45600.00",
      currency: "NGN",
      fulfillmentsByState: { requested: 2, delivered: 8 },
      payoutConfigured: true,
    });
    // The legacy varchar-major sum rides a numeric cast, and the settlement
    // alias from the authorize context is never copied into the result.
    const ordersQuery = pool.calls.find((c) => /FROM public\.orders/.test(c.text));
    expect(ordersQuery!.text).toContain("total_amount::numeric");
    expect(JSON.stringify(earnings)).not.toContain("secret-alias");
  });
});

describe("updateStorefrontProfile", () => {
  const AUTHORIZE = {
    match: /commerce\.authorize_merchant_portal/,
    result: { rows: [{ provider_id: 7, medusa_store_id: "s", default_stock_location_id: null, payment_enabled: false, settlement_fsp_alias: null, currency_code: "NGN" }] },
  };
  const PROFILE_ROW = {
    name: "Mama Put Kitchen",
    business_name: "Mama Put Ventures Ltd",
    address: "12 Marina Road, Lagos",
    latitude: "6.5243793",
    longitude: "3.3792057",
    category: "general",
  };

  it("updates only display columns, never status/verification/rating/commission", async () => {
    const pool = createPool([
      AUTHORIZE,
      { match: /FROM public\.consumer_processed_events/, result: { rows: [] } },
      { match: /UPDATE public\.service_providers/, result: { rows: [PROFILE_ROW] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const result = await updateStorefrontProfile({
      actorUserId: 42,
      providerId: 7,
      displayName: "Mama Put Kitchen & Bar",
      address: "14 Marina Road, Lagos",
      idempotencyKey: "storefront-key-1",
    });
    expect(result.replayed).toBe(false);
    const update = pool.calls.find((c) => /UPDATE public\.service_providers/.test(c.text));
    expect(update!.text).not.toMatch(/status|verification|rating|commission/);
    expect(update!.values[1]).toBe("Mama Put Kitchen & Bar");
    expect(update!.values[2]).toBe("14 Marina Road, Lagos");
  });

  it("replays via the ledger and refuses empty updates", async () => {
    const pool = createPool([
      AUTHORIZE,
      { match: /FROM public\.consumer_processed_events/, result: { rows: [{ result_json: { provider_id: 7 } }] } },
      { match: /SELECT name, business_name, address/, result: { rows: [PROFILE_ROW] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const replayed = await updateStorefrontProfile({
      actorUserId: 42,
      providerId: 7,
      displayName: "Ignored",
      idempotencyKey: "storefront-key-1",
    });
    expect(replayed.replayed).toBe(true);
    expect(pool.calls.some((c) => /UPDATE public\.service_providers/.test(c.text))).toBe(false);

    await expect(
      updateStorefrontProfile({ actorUserId: 42, providerId: 7, idempotencyKey: "storefront-key-2" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "storefront_profile_no_changes" });
  });
});
