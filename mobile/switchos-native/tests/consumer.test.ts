/**
 * P2-C consumer screens — Node-level logic tests (vitest).
 *
 * Covers the contractual wire/formatter logic without native modules:
 *   - idempotency keys (crypto-UUID shape, server regex, uniqueness)
 *   - money: TEXT major -> integer minor (string math, no floats), subtotal
 *     math on string minor units, ₦/currency formatting via lib/money.ts
 *   - checkout form validation (mirrors checkoutInputSchema bounds)
 *   - checkout session status labels, rating bounds
 *   - offline-badge state selection (selectConsumerDataMode)
 *   - PowerSync replica row mappers + timeline ordering
 *   - catalog source mappers + static screen/boundary assertions
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// The mobile template AppRouter stub has no consumer surface; hooks are not
// exercised here (pure logic only), so the bridge target is mocked out.
vi.mock("@/lib/trpc", () => ({ trpc: {} }));
// lib/consumer.ts imports money through the app alias; redirect to the real
// implementation so formatter behavior is genuinely tested.
vi.mock("@/lib/money", async () => await vi.importActual("../lib/money"));
// consumerCatalogSource imports consumerOffline via the app alias; redirect
// to the real module (its provider import is stubbed below).
vi.mock("@/lib/consumerOffline", async () => await vi.importActual("../lib/consumerOffline"));
// consumerOffline imports the provider (react-native chain); stub it.
vi.mock("@/lib/powersync/PowerSyncProvider", () => ({
  getPowerSyncDatabase: vi.fn(async () => null),
  usePowerSyncStatus: () => ({
    available: true,
    connected: false,
    connecting: false,
    hasSynced: true,
    lastSyncAt: null,
    uploading: false,
    downloading: false,
    uploadQueueSize: 0,
    downloadProgress: null,
  }),
}));

import {
  cartSubtotalMinor,
  checkoutSessionStatusLabel,
  CONSUMER_IDEMPOTENCY_KEY_RE,
  formatMajorAmount,
  isValidRating,
  newConsumerIdempotencyKey,
  parseMajorToMinor,
  validateCheckoutForm,
  type ConsumerCartItem,
} from "../lib/consumer";
import {
  mapReplicaOrderRow,
  mapReplicaTrackingRow,
  selectConsumerDataMode,
  sortTimeline,
} from "../lib/consumerOffline";
import {
  mapReplicaCatalogItem,
  mapReplicaProvider,
  mapReplicaVertical,
} from "../lib/consumerCatalogSource";
import { formatMinor } from "../lib/money";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------------

describe("newConsumerIdempotencyKey", () => {
  it("matches the server regex and carries the prefix", () => {
    const key = newConsumerIdempotencyKey("co");
    expect(CONSUMER_IDEMPOTENCY_KEY_RE.test(key)).toBe(true);
    expect(key.startsWith("co-")).toBe(true);
  });

  it("embeds a UUID-v4-shaped token", () => {
    const key = newConsumerIdempotencyKey("sub");
    expect(key).toMatch(
      /^sub-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("is unique across generations", () => {
    const keys = new Set(
      Array.from({ length: 500 }, () => newConsumerIdempotencyKey("co")),
    );
    expect(keys.size).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Money: TEXT major -> minor (integer-exact string math)
// ---------------------------------------------------------------------------

describe("parseMajorToMinor", () => {
  it.each([
    ["120.00", 12000],
    ["2500.50", 250050],
    ["0.5", 50],
    ["7", 700],
    ["0.01", 1],
    ["18500.99", 1850099],
  ])("converts %s to %i minor units", (input, expected) => {
    expect(parseMajorToMinor(input)).toBe(expected);
  });

  it("never floats: 19.99 stays exact", () => {
    // 19.99 * 100 in IEEE754 is 1998.99… — string math must yield 1999.
    expect(parseMajorToMinor("19.99")).toBe(1999);
    expect(parseMajorToMinor("0.1")).toBe(10);
    expect(parseMajorToMinor("0.07")).toBe(7);
  });

  it("returns null for malformed input", () => {
    expect(parseMajorToMinor("abc")).toBeNull();
    expect(parseMajorToMinor("1.2.3")).toBeNull();
    expect(parseMajorToMinor("")).toBeNull();
    expect(parseMajorToMinor(null)).toBeNull();
    expect(parseMajorToMinor(undefined)).toBeNull();
  });

  it("handles negatives and truncates beyond 2 fraction digits", () => {
    expect(parseMajorToMinor("-12.34")).toBe(-1234);
    expect(parseMajorToMinor("1.999")).toBe(199);
  });
});

describe("formatMajorAmount / formatMinor", () => {
  it("formats naira with the ₦ symbol", () => {
    expect(formatMajorAmount("1530.50", "NGN")).toBe("₦1,530.50");
    expect(formatMinor(12000)).toBe("₦120.00");
  });

  it("prefixes non-NGN currencies", () => {
    expect(formatMajorAmount("42.10", "EUR")).toBe("EUR 42.10");
  });

  it("renders a dash for unparseable amounts", () => {
    expect(formatMajorAmount("not-a-price")).toBe("—");
  });
});

describe("cartSubtotalMinor", () => {
  const item = (unitPriceMinor: string, quantity: number): ConsumerCartItem => ({
    id: "i",
    cartId: "c",
    catalogItemId: null,
    name: "n",
    unitPriceMinor,
    quantity,
    modifiers: [],
  });

  it("sums string minor units with integer math", () => {
    expect(cartSubtotalMinor([item("250000", 2), item("120050", 1)])).toBe(620050);
  });

  it("returns 0 for an empty cart and tolerates string wire values", () => {
    expect(cartSubtotalMinor([])).toBe(0);
    expect(cartSubtotalMinor([item("not-a-number" as string, 3)])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Checkout form validation (mirrors checkoutInputSchema)
// ---------------------------------------------------------------------------

describe("validateCheckoutForm", () => {
  const valid = { deliveryAddress: "12 Broad Street, Lagos", deliveryLat: 6.5244, deliveryLng: 3.3792 };

  it("accepts a valid form", () => {
    expect(validateCheckoutForm(valid)).toBeNull();
    expect(validateCheckoutForm({ ...valid, notes: "Leave at gate" })).toBeNull();
  });

  it.each([
    ["short address", { deliveryAddress: "ab" }, "3–500"],
    ["lat out of range", { deliveryLat: 91 }, "Latitude"],
    ["lat invalid", { deliveryLat: Number.NaN }, "Latitude"],
    ["lng out of range", { deliveryLng: -181 }, "Longitude"],
    ["notes too long", { notes: "x".repeat(2001) }, "2000"],
  ])("rejects %s", (_label, patch, expected) => {
    const result = validateCheckoutForm({ ...valid, ...patch });
    expect(result).toContain(expected);
  });
});

describe("checkoutSessionStatusLabel / isValidRating", () => {
  it("labels the contractual session statuses", () => {
    expect(checkoutSessionStatusLabel("open")).toBe("Awaiting payment initiation");
    expect(checkoutSessionStatusLabel("payment_pending")).toBe("Payment pending");
    expect(checkoutSessionStatusLabel("paid")).toBe("Paid");
    expect(checkoutSessionStatusLabel("failed")).toBe("Payment failed");
    expect(checkoutSessionStatusLabel("expired")).toBe("Session expired");
  });

  it("bounds ratings to integers 1..5", () => {
    expect(isValidRating(3)).toBe(true);
    expect(isValidRating(0)).toBe(false);
    expect(isValidRating(6)).toBe(false);
    expect(isValidRating(2.5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Offline-badge state selection
// ---------------------------------------------------------------------------

describe("selectConsumerDataMode", () => {
  it("is live when connected without a read error", () => {
    expect(
      selectConsumerDataMode({ syncConnected: true, syncHasSynced: true }),
    ).toBe("live");
  });

  it("downgrades to the replica on a live-read error even when connected", () => {
    expect(
      selectConsumerDataMode({ syncConnected: true, syncHasSynced: true, liveError: true }),
    ).toBe("offline-replica");
  });

  it("uses the replica when disconnected after a completed sync", () => {
    expect(
      selectConsumerDataMode({ syncConnected: false, syncHasSynced: true }),
    ).toBe("offline-replica");
  });

  it("is unavailable when disconnected and never synced", () => {
    expect(
      selectConsumerDataMode({ syncConnected: false, syncHasSynced: false }),
    ).toBe("unavailable");
  });
});

// ---------------------------------------------------------------------------
// Replica mappers + timeline ordering
// ---------------------------------------------------------------------------

describe("replica mappers", () => {
  it("maps order rows (snake_case -> camelCase, id text -> number)", () => {
    const mapped = mapReplicaOrderRow({
      id: "42",
      order_number: "ORD-0042",
      status: "delivered",
      total_amount: "1530.50",
      created_at: "2026-11-01T10:00:00.000Z",
      updated_at: null,
      delivery_address: "12 Broad St",
      estimated_delivery_time: null,
      actual_delivery_time: "2026-11-01T12:00:00.000Z",
    });
    expect(mapped.id).toBe(42);
    expect(mapped.orderNumber).toBe("ORD-0042");
    expect(mapped.totalAmount).toBe("1530.50");
    expect(formatMajorAmount(mapped.totalAmount)).toBe("₦1,530.50");
  });

  it("maps tracking rows into timeline events with ETA detail", () => {
    const event = mapReplicaTrackingRow({
      id: "9",
      order_id: "42",
      event_type: "courier_assigned",
      status_label: "Courier assigned",
      eta_minutes: 25,
      event_time: "2026-11-01T11:00:00.000Z",
      metadata: null,
    });
    expect(event.label).toBe("Courier assigned");
    expect(event.detail).toBe("ETA 25 min");
  });

  it("maps catalog rows (vertical/provider/item) with major-unit prices intact", () => {
    expect(
      mapReplicaVertical({ id: "3", name: "Home", slug: "home", description: null, icon: "home" }),
    ).toEqual({ id: 3, name: "Home", slug: "home", description: null, icon: "home" });
    const provider = mapReplicaProvider({
      id: "11",
      vertical_id: "1",
      name: "Amala Spot",
      business_name: "Amala Spot Ltd",
      address: "12 Broad St",
      rating: "4.60",
      status: "active",
    });
    expect(provider.verticalId).toBe(1);
    expect(provider.rating).toBe("4.60");
    const itemRow = mapReplicaCatalogItem({
      id: "111",
      provider_id: "11",
      sku: "AMALA-CLASSIC",
      item_name: "Amala Combo",
      description: null,
      price: "2500.00",
      currency: "NGN",
      is_available: 1,
    });
    expect(itemRow.priceMajor).toBe("2500.00");
    expect(parseMajorToMinor(itemRow.priceMajor)).toBe(250000);
  });
});

describe("sortTimeline", () => {
  it("orders ascending by occurredAt", () => {
    const sorted = sortTimeline([
      { occurredAt: "2026-11-01T12:00:00.000Z", label: "b" },
      { occurredAt: "2026-11-01T10:00:00.000Z", label: "a" },
      { occurredAt: "2026-11-01T13:00:00.000Z", label: "c" },
    ]);
    expect(sorted.map((event) => event.label)).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// Static wiring assertions
// ---------------------------------------------------------------------------

describe("screen boundary + wiring (static)", () => {
  const screen = (name: string) =>
    readFileSync(join(HERE, `../app/consumer/${name}`), "utf8");

  it("every consumer screen documents the offline/online-only boundary", () => {
    for (const name of ["marketplace.tsx", "cart.tsx", "orders.tsx", "subscription.tsx"]) {
      expect(screen(name)).toContain("OFFLINE BOUNDARY");
      expect(screen(name)).toContain("ONLINE-ONLY");
    }
  });

  it("marketplace consumes the catalog source helper (live/mock/replica swap point)", () => {
    const source = screen("marketplace.tsx");
    expect(source).toContain("@/lib/consumerCatalogSource");
    const helper = readFileSync(
      join(HERE, "../lib/consumerCatalogSource.ts"),
      "utf8",
    );
    expect(helper).toContain("consumerCatalog");
    expect(helper).toContain("MOCK_VERTICALS");
  });

  it("checkout uses an idempotency key and minor-unit formatting", () => {
    const cart = screen("cart.tsx");
    expect(cart).toContain("useCheckoutIdempotencyKey");
    expect(cart).toContain("formatMinor");
    expect(cart).toContain("cartSubtotalMinor");
  });

  it("hub exposes the Shop entry", () => {
    const hub = readFileSync(join(HERE, "../app/(tabs)/index.tsx"), "utf8");
    expect(hub).toContain("/consumer/marketplace");
    expect(hub).toContain("Shop the marketplace");
  });
});
