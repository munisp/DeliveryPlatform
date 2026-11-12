/**
 * P4-N merchant API — Node-level wire/logic tests (vitest).
 *
 * Covers: request shaping (offline queue SyncAction, lane merchant_catalog),
 * Hermes-safe idempotency keys, merchant-legal fulfillment edges, error
 * mapping (merchantSelfServe pg-code contract), and merchant_store replica
 * mappers. Hooks are not exercised; the bridge target is mocked.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/trpc", () => ({ trpc: {} }));
vi.mock("@/lib/money", async () => await vi.importActual("../money"));
vi.mock("@/lib/consumer", async () => await vi.importActual("../consumer"));

import {
  buildMerchantQueuedAction,
  mapMerchantApiError,
  mapMerchantReplicaCatalogRow,
  mapMerchantReplicaProviderRow,
  MERCHANT_FULFILLMENT_STATUSES,
  MERCHANT_IDEMPOTENCY_KEY_RE,
  MERCHANT_QUEUE_LANE,
  merchantFulfillmentActions,
  newMerchantIdempotencyKey,
  parseMerchantQueuedPayload,
} from "../merchantApi";
import { formatMajorAmount } from "../consumer";

describe("merchant idempotency keys", () => {
  it("matches the server regex and UUID-v4 shape", () => {
    const key = newMerchantIdempotencyKey("mft");
    expect(MERCHANT_IDEMPOTENCY_KEY_RE.test(key)).toBe(true);
    expect(key).toMatch(
      /^mft-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("is unique across generations", () => {
    const keys = new Set(Array.from({ length: 300 }, () => newMerchantIdempotencyKey("msp")));
    expect(keys.size).toBe(300);
  });
});

describe("merchant fulfillment state machine (legal edges)", () => {
  it("requested -> accept|reject; accepted -> ready; terminal -> none", () => {
    expect(merchantFulfillmentActions("requested")).toEqual(["accept", "reject"]);
    expect(merchantFulfillmentActions("accepted")).toEqual(["ready"]);
    for (const terminal of ["assigned", "out_for_delivery", "delivered", "cancelled", "failed"]) {
      expect(merchantFulfillmentActions(terminal)).toEqual([]);
    }
  });

  it("status enum mirrors the server 7-value schema", () => {
    expect(MERCHANT_FULFILLMENT_STATUSES).toHaveLength(7);
    expect(MERCHANT_FULFILLMENT_STATUSES).toContain("requested");
    expect(MERCHANT_FULFILLMENT_STATUSES).toContain("failed");
  });
});

describe("offline queue fallback (merchant_catalog lane)", () => {
  const now = new Date("2026-11-12T10:00:00.000Z");

  it("shapes a transition SyncAction with embedded idempotency key", () => {
    const action = buildMerchantQueuedAction({
      accountId: "merchant:11",
      kind: "merchant_transition_fulfillment",
      providerId: 11,
      fulfillmentId: "9c0f7b9e-2c1d-4e5f-8a9b-0c1d2e3f4a5b",
      action: "accept",
      now,
    });
    expect(action.lane).toBe(MERCHANT_QUEUE_LANE);
    expect(action.lane).toBe("merchant_catalog");
    expect(action.type).toBe("merchant_transition_fulfillment");
    expect(action.attempts).toBe(0);
    const payload = parseMerchantQueuedPayload(action.payload);
    expect(payload.providerId).toBe(11);
    expect(payload.action).toBe("accept");
    expect(MERCHANT_IDEMPOTENCY_KEY_RE.test(payload.idempotencyKey)).toBe(true);
  });

  it("shapes a storefront update action", () => {
    const action = buildMerchantQueuedAction({
      accountId: "merchant:11",
      kind: "merchant_update_storefront",
      providerId: 11,
      displayName: "Amala Spot (Lekki)",
      now,
    });
    const payload = parseMerchantQueuedPayload(action.payload);
    expect(payload.kind).toBe("merchant_update_storefront");
    expect(payload.displayName).toBe("Amala Spot (Lekki)");
  });

  it("rejects malformed queue intents", () => {
    expect(() =>
      buildMerchantQueuedAction({
        accountId: "m",
        kind: "merchant_transition_fulfillment",
        providerId: 11,
        action: "accept",
        now,
      }),
    ).toThrow("merchant_transition_requires_fulfillment_and_action");
    expect(() =>
      buildMerchantQueuedAction({
        accountId: "m",
        kind: "merchant_transition_fulfillment",
        providerId: 11,
        fulfillmentId: "f",
        action: "ship" as never,
        now,
      }),
    ).toThrow("merchant_transition_bad_action");
    expect(() =>
      buildMerchantQueuedAction({
        accountId: "m",
        kind: "merchant_update_storefront",
        providerId: 11,
        now,
      }),
    ).toThrow("merchant_storefront_requires_change");
    expect(() =>
      buildMerchantQueuedAction({
        accountId: "m",
        kind: "merchant_transition_fulfillment",
        providerId: 0,
        fulfillmentId: "f",
        action: "accept",
        now,
      }),
    ).toThrow("merchant_provider_id_invalid");
  });

  it("parse round-trips and rejects unknown kinds / bad keys", () => {
    const action = buildMerchantQueuedAction({
      accountId: "m",
      kind: "merchant_update_storefront",
      providerId: 5,
      address: "4 Adeola Odeku, VI",
      now,
    });
    expect(parseMerchantQueuedPayload(action.payload).providerId).toBe(5);
    expect(() => parseMerchantQueuedPayload(JSON.stringify({ kind: "nope" }))).toThrow(
      "merchant_queue_unknown_kind",
    );
  });
});

describe("error mapping (pg-code contract)", () => {
  it.each([
    ["FORBIDDEN: merchant_portal_forbidden", "forbidden"],
    ["NOT_FOUND: fulfillment_request", "not_found"],
    ["CONFLICT: fulfillment_illegal_transition", "conflict"],
    ["storefront_profile_no_changes", "bad_request"],
    ["Failed to fetch", "offline"],
    ["something else", "unknown"],
  ])("maps %s -> %s", (message, expected) => {
    expect(mapMerchantApiError(new Error(message))).toBe(expected);
  });
});

describe("merchant_store replica mappers", () => {
  it("maps the provider identity row", () => {
    const provider = mapMerchantReplicaProviderRow({
      id: "11",
      name: "Amala Spot",
      business_name: "Amala Spot Ltd",
      address: "12 Broad St",
      status: "active",
    });
    expect(provider.providerId).toBe(11);
    expect(provider.businessName).toBe("Amala Spot Ltd");
  });

  it("maps catalog rows with TEXT major prices intact (no floats)", () => {
    const item = mapMerchantReplicaCatalogRow({
      id: "111",
      provider_id: "11",
      sku: "AMALA-CLASSIC",
      item_name: "Amala Combo",
      description: null,
      price: "2500.00",
      currency: "NGN",
      is_available: 1,
    });
    expect(item.priceMajor).toBe("2500.00");
    expect(formatMajorAmount(item.priceMajor, item.currency)).toBe("₦2,500.00");
  });
});
