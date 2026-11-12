import { describe, expect, it } from "vitest";

import {
  CONSUMER_IDEMPOTENCY_KEY_RE,
  cartItemCount,
  cartSubtotalMinor,
  cartVersion,
  computeFeeBreakdown,
  computePlatformFeeMinor,
  formatNairaMajor,
  formatNairaMinor,
  generateConsumerIdempotencyKey,
  getOrCreateCheckoutKey,
  isTerminalCheckoutStatus,
  majorToMinor,
  normalizeCartPayload,
  normalizeCatalogItems,
  normalizeCheckoutResult,
  normalizeGroupOrder,
  normalizeMembershipPlans,
  normalizeProviders,
  normalizeSubscription,
  normalizeTrackingEvents,
  normalizeVerticals,
} from "./consumerWire";

// ---------- ₦ fee-display formatting (exact 2-decimal integer math) ----------

describe("formatNairaMinor", () => {
  it("formats minor units with ₦, thousands grouping and 2 decimals", () => {
    expect(formatNairaMinor(660000)).toBe("₦6,600.00");
    expect(formatNairaMinor(5)).toBe("₦0.05");
    expect(formatNairaMinor(0)).toBe("₦0.00");
    expect(formatNairaMinor(123456789)).toBe("₦1,234,567.89");
    expect(formatNairaMinor(50000)).toBe("₦500.00");
  });

  it("accepts stringified bigint columns", () => {
    expect(formatNairaMinor("660000")).toBe("₦6,600.00");
    expect(formatNairaMinor(660000n)).toBe("₦6,600.00");
  });

  it("renders negatives with a leading sign", () => {
    expect(formatNairaMinor(-1000)).toBe("-₦10.00");
  });

  it("never float-parses: rejects unsafe integers and non-integers", () => {
    expect(() => formatNairaMinor(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => formatNairaMinor(10.5)).toThrow();
    expect(() => formatNairaMinor("12.34")).toThrow();
  });
});

describe("formatNairaMajor / majorToMinor", () => {
  it("converts major-unit catalog strings exactly", () => {
    expect(majorToMinor("6600.00")).toBe(660000);
    expect(majorToMinor("0.05")).toBe(5);
    expect(majorToMinor("1500")).toBe(150000);
    expect(majorToMinor("1500.5")).toBe(150050);
    expect(majorToMinor("2500.00")).toBe(250000);
  });

  it("formats major-unit strings for display", () => {
    expect(formatNairaMajor("6600.00")).toBe("₦6,600.00");
    expect(formatNairaMajor("0.05")).toBe("₦0.05");
    expect(formatNairaMajor("12345")).toBe("₦12,345.00");
  });

  it("rejects invalid or lossy input instead of float-parsing", () => {
    expect(() => majorToMinor("12.345")).toThrow();
    expect(() => majorToMinor("abc")).toThrow();
    expect(() => majorToMinor("-5.00")).toThrow();
    expect(() => majorToMinor("")).toThrow();
  });
});

// ---------- fee math (mirrors server consumerCommerce) ----------

describe("fee math", () => {
  it("computes platform fee as floor(subtotal * bps / 10000)", () => {
    expect(computePlatformFeeMinor(660000, 500)).toBe(33000);
    expect(computePlatformFeeMinor(199, 500)).toBe(9); // 9.95 floors to 9
    expect(computePlatformFeeMinor(0, 500)).toBe(0);
    expect(computePlatformFeeMinor(1000000, 3000)).toBe(300000);
  });

  it("builds a full breakdown with exact totals", () => {
    expect(computeFeeBreakdown(660000, 500, 50000)).toEqual({
      subtotalMinor: 660000,
      platformFeeMinor: 33000,
      deliveryFeeMinor: 50000,
      totalMinor: 743000,
    });
    expect(formatNairaMinor(743000)).toBe("₦7,430.00");
  });
});

// ---------- idempotency-key generation ----------

describe("generateConsumerIdempotencyKey", () => {
  it("matches the server regex ^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$", () => {
    for (let i = 0; i < 50; i += 1) {
      const key = generateConsumerIdempotencyKey(
        "checkout",
        "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        "2026-11-12T09:00:00.000Z",
      );
      expect(key).toMatch(CONSUMER_IDEMPOTENCY_KEY_RE);
      expect(key.length).toBeLessThanOrEqual(128);
    }
  });

  it("is unique per call (fresh UUID tail)", () => {
    const a = generateConsumerIdempotencyKey("cart");
    const b = generateConsumerIdempotencyKey("cart");
    expect(a).not.toBe(b);
  });

  it("sanitizes disallowed characters and survives very long segments", () => {
    const key = generateConsumerIdempotencyKey("subscribe", "x".repeat(200), "plan 1");
    expect(key).toMatch(CONSUMER_IDEMPOTENCY_KEY_RE);
    expect(key.length).toBeLessThanOrEqual(128);
  });
});

describe("getOrCreateCheckoutKey", () => {
  function fakeStorage() {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  }

  const cartId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

  it("returns the same key for the same cart version (retry-safe)", () => {
    const storage = fakeStorage();
    const first = getOrCreateCheckoutKey(cartId, "v1", storage);
    const second = getOrCreateCheckoutKey(cartId, "v1", storage);
    expect(second).toBe(first);
    expect(first).toMatch(CONSUMER_IDEMPOTENCY_KEY_RE);
  });

  it("rotates the key when the cart version changes", () => {
    const storage = fakeStorage();
    const first = getOrCreateCheckoutKey(cartId, "v1", storage);
    const rotated = getOrCreateCheckoutKey(cartId, "v2", storage);
    expect(rotated).not.toBe(first);
    expect(rotated).toMatch(CONSUMER_IDEMPOTENCY_KEY_RE);
  });

  it("works without storage (in-memory fallback)", () => {
    const key = getOrCreateCheckoutKey(cartId, "v9", null);
    expect(key).toMatch(CONSUMER_IDEMPOTENCY_KEY_RE);
    expect(getOrCreateCheckoutKey(cartId, "v9", null)).toBe(key);
  });
});

// ---------- catalog response shaping ----------

describe("catalog response shaping", () => {
  it("normalizes verticals (camelCase server shape)", () => {
    const verticals = normalizeVerticals([
      { id: 2, name: "Food", slug: "food", description: "Meals", icon: "🍲" },
      { id: 1, name: "Groceries", slug: "groceries", description: null, icon: null },
      { broken: true },
    ]);
    expect(verticals).toHaveLength(2);
    expect(verticals[0]).toEqual({
      id: 2,
      name: "Food",
      slug: "food",
      description: "Meals",
      icon: "🍲",
    });
  });

  it("normalizes providers tolerating snake_case keys", () => {
    const providers = normalizeProviders([
      {
        id: 7,
        vertical_id: 3,
        name: "Ada",
        business_name: "Ada's Kitchen",
        address: "12 Marina Rd",
        rating: "4.50",
        status: "active",
      },
    ]);
    expect(providers).toEqual([
      {
        id: 7,
        verticalId: 3,
        name: "Ada",
        businessName: "Ada's Kitchen",
        address: "12 Marina Rd",
        rating: "4.50", // varchar preserved as string, never float-parsed
        status: "active",
      },
    ]);
  });

  it("normalizes catalog items keeping price as an exact major string", () => {
    const items = normalizeCatalogItems([
      {
        id: 11,
        provider_id: 7,
        sku: "JLF-R",
        item_name: "Jollof rice",
        description: null,
        price_major: "1500.00",
        currency: "NGN",
      },
      { id: 12 }, // no price -> dropped
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].priceMajor).toBe("1500.00");
    expect(items[0].itemName).toBe("Jollof rice");
    expect(formatNairaMajor(items[0].priceMajor)).toBe("₦1,500.00");
    expect(majorToMinor(items[0].priceMajor)).toBe(150000);
  });

  it("normalizes membership plans", () => {
    const plans = normalizeMembershipPlans([
      {
        id: 1,
        plan_code: "PLUS",
        plan_name: "SwitchOS Plus",
        monthly_price_major: "2500.00",
        delivery_fee_discount_major: "200.00",
        priority_support: true,
        cashback_rate_major: "2.50",
        perks: ["free delivery"],
      },
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0].monthlyPriceMajor).toBe("2500.00");
    expect(formatNairaMajor(plans[0].monthlyPriceMajor)).toBe("₦2,500.00");
    expect(plans[0].perks).toEqual(["free delivery"]);
  });

  it("returns empty arrays for malformed payloads", () => {
    expect(normalizeVerticals(undefined)).toEqual([]);
    expect(normalizeProviders({ nope: 1 })).toEqual([]);
    expect(normalizeCatalogItems(null)).toEqual([]);
    expect(normalizeMembershipPlans("x")).toEqual([]);
  });
});

// ---------- cart payload shaping + subtotal exactness ----------

describe("cart payload normalization", () => {
  it("normalizes the myCart {cart, items} shape with stringified bigints", () => {
    const payload = normalizeCartPayload({
      cart: {
        id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        status: "active",
        service_provider_id: 7,
        vertical_id: 3,
        created_at: "2026-11-12T08:00:00.000Z",
        updated_at: "2026-11-12T09:00:00.000Z",
      },
      items: [
        {
          id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
          cart_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
          catalog_item_id: 11,
          name: "Jollof rice",
          unit_price_minor: "150000",
          quantity: 2,
          modifiers: [{ spice: "hot" }],
        },
        {
          id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
          cartId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
          catalogItemId: null,
          name: "Delivery note",
          unitPriceMinor: 5,
          quantity: 1,
          modifiers: [],
        },
      ],
    });
    expect(payload).not.toBeNull();
    expect(payload!.cart.serviceProviderId).toBe(7);
    expect(payload!.items[0].unitPriceMinor).toBe(150000);
    expect(payload!.items[0].modifiers).toEqual([{ spice: "hot" }]);
    expect(cartSubtotalMinor(payload!.items)).toBe(300005);
    expect(formatNairaMinor(cartSubtotalMinor(payload!.items))).toBe(
      "₦3,000.05",
    );
    expect(cartItemCount(payload!.items)).toBe(3);
    expect(cartVersion(payload!.cart)).toBe("2026-11-12T09:00:00.000Z");
  });

  it("keeps subtotal exact at bigint scale", () => {
    const items = [
      {
        id: "a",
        cartId: "c",
        catalogItemId: 1,
        name: "x",
        unitPriceMinor: Number.MAX_SAFE_INTEGER - 10,
        quantity: 1,
        modifiers: [],
      },
    ];
    expect(cartSubtotalMinor(items)).toBe(Number.MAX_SAFE_INTEGER - 10);
  });

  it("returns null when the cart is absent (empty myCart)", () => {
    expect(normalizeCartPayload(null)).toBeNull();
    expect(normalizeCartPayload({})).toBeNull();
  });
});

// ---------- checkout / group / subscription / tracking shaping ----------

describe("checkout + group + subscription + tracking shaping", () => {
  it("normalizes a checkout result and detects terminal statuses", () => {
    const checkout = normalizeCheckoutResult({
      order_id: 42,
      order_number: "SO-100042",
      checkout_session_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      status: "payment_pending",
      subtotal_minor: "660000",
      platform_fee_minor: 33000,
      delivery_fee_minor: 50000,
      total_minor: 743000,
      currency: "NGN",
      expires_at: "2026-11-12T10:00:00.000Z",
      payment_reference: "cp-f47ac10b",
      replayed: false,
    });
    expect(checkout).not.toBeNull();
    expect(checkout!.totalMinor).toBe(743000);
    expect(checkout!.paymentReference).toBe("cp-f47ac10b");
    expect(isTerminalCheckoutStatus(checkout!.status)).toBe(false);
    expect(isTerminalCheckoutStatus("paid")).toBe(true);
    expect(isTerminalCheckoutStatus("failed")).toBe(true);
    expect(isTerminalCheckoutStatus("expired")).toBe(true);
    expect(isTerminalCheckoutStatus("open")).toBe(false);
  });

  it("normalizes group-order join results", () => {
    const group = normalizeGroupOrder({
      id: "g1",
      status: "open",
      share_code: "ABCD2345",
      max_participants: 8,
      participant_count: "3",
      already_joined: false,
    });
    expect(group).toEqual({
      id: "g1",
      status: "open",
      shareCode: "ABCD2345",
      maxParticipants: 8,
      participantCount: 3,
      alreadyJoined: false,
    });
  });

  it("normalizes subscriptions with period bounds", () => {
    const sub = normalizeSubscription({
      id: "s1",
      plan_id: 1,
      status: "active",
      current_period_start: "2026-11-01T00:00:00.000Z",
      current_period_end: "2026-12-01T00:00:00.000Z",
    });
    expect(sub!.planId).toBe(1);
    expect(sub!.currentPeriodEnd).toBe("2026-12-01T00:00:00.000Z");
  });

  it("normalizes order_tracking_events rows", () => {
    const events = normalizeTrackingEvents([
      {
        id: 5,
        event_type: "driver_assigned",
        status_label: "Courier assigned",
        eta_minutes: "25",
        event_time: "2026-11-12T09:30:00.000Z",
      },
      { broken: true },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      id: 5,
      eventType: "driver_assigned",
      statusLabel: "Courier assigned",
      etaMinutes: 25,
      eventTime: "2026-11-12T09:30:00.000Z",
    });
    expect(normalizeTrackingEvents(null)).toEqual([]);
  });
});
