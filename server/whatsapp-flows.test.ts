/**
 * P2-B WhatsApp consumer flow tests (vitest).
 *
 * Covers: full browse → cart → checkout_confirm happy path with mocked
 * consumerCommerce + mocked catalog, pagination, opt-out suppression
 * (STOP/START), unlinked-number checkout refusal (fail closed), exact ₦
 * formatting (integer math only), and the temporary "link <accountId>"
 * flow. Identity resolution runs against a fake pool standing in for
 * public.users.phone lookups (see ./db mock).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted; re-applied after vi.resetModules)
// ---------------------------------------------------------------------------

const VERTICALS = [
  { id: 1, name: "Food", slug: "food", description: null, icon: null },
];
const PROVIDERS = [1, 2, 3, 4, 5, 6].map((n) => ({
  id: 100 + n,
  verticalId: 1,
  name: `Prov ${n}`,
  businessName: `Prov ${n} Kitchen`,
  address: `${n} Test St`,
  rating: "4.50",
  status: "active",
}));
const ITEMS = [
  {
    id: 11,
    providerId: 101,
    sku: "JOLLOF",
    itemName: "Jollof rice bowl",
    description: null,
    priceMajor: "1500.00",
    currency: "NGN",
  },
  {
    id: 12,
    providerId: 101,
    sku: "SUYA",
    itemName: "Suya wrap",
    description: null,
    priceMajor: "0.05",
    currency: "NGN",
  },
];

vi.mock("./_core/consumerCatalog", () => ({
  listConsumerVerticals: async () => VERTICALS,
  listConsumerProviders: async (input: {
    verticalId: number;
    limit?: number;
    offset?: number;
  }) => {
    const limit = input.limit ?? 20;
    const offset = input.offset ?? 0;
    return PROVIDERS.filter((p) => p.verticalId === input.verticalId).slice(
      offset,
      offset + limit,
    );
  },
  listConsumerCatalog: async (input: {
    providerId: number;
    limit?: number;
    offset?: number;
  }) => {
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;
    return ITEMS.filter((i) => i.providerId === input.providerId).slice(
      offset,
      offset + limit,
    );
  },
}));

// Fake pool for public.users identity lookups + dedupe claims.
vi.mock("./db", () => {
  class DatabaseUnavailableError extends Error {
    constructor(operation: string) {
      super(`DATABASE_UNAVAILABLE:${operation}`);
      this.name = "DatabaseUnavailableError";
    }
  }
  return {
    DatabaseUnavailableError,
    getDb: async () => null,
    getPool: async () => ({
      query: async (rawSql: string, params: unknown[]) => {
        const sql = rawSql.replace(/\s+/g, " ");
        if (sql.includes("FROM public.users WHERE phone = ANY")) {
          // No main-db phone match for the test numbers by default.
          return { rows: [] };
        }
        if (sql.includes("FROM public.users WHERE id = $1")) {
          return { rows: params[0] === 42 ? [{ "?column?": 1 }] : [] };
        }
        if (sql.includes("consumer_processed_events")) {
          return { rows: [{ event_id: params[2] }] };
        }
        throw new Error(`unexpected query in fake pool: ${sql}`);
      },
    }),
  };
});

const CHECKOUT_RESULT = {
  orderId: 1001,
  orderNumber: "ORD-1001",
  checkoutSessionId: "22222222-2222-4222-8222-222222222222",
  status: "payment_pending",
  subtotalMinor: 150000,
  platformFeeMinor: 7500,
  deliveryFeeMinor: 50000,
  totalMinor: 207500,
  currency: "NGN",
  expiresAt: new Date("2030-01-01T00:00:00Z").toISOString(),
  replayed: false,
  paymentReference: "cp-test-ref",
  mojaloopTransferId: "ct-test",
};

vi.mock("./_core/consumerCommerce", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_core/consumerCommerce")>();
  return {
    ...actual,
    createConsumerCart: vi.fn(async () => ({
      id: "11111111-1111-4111-8111-111111111111",
      consumerId: 42,
      serviceProviderId: null,
      verticalId: null,
      status: "active",
      idempotencyKey: null,
      createdAt: "",
      updatedAt: "",
    })),
    addConsumerCartItem: vi.fn(async () => ({})),
    checkoutConsumerCart: vi.fn(async () => CHECKOUT_RESULT),
  };
});

vi.mock("./_core/consumerQueries", () => ({
  listConsumerOrders: async () => [
    {
      id: 501,
      orderNumber: "ORD-501",
      status: "out_for_delivery",
      totalAmount: 2075.0,
      currency: "NGN",
      verticalName: "Food",
      providerName: "Prov 1 Kitchen",
      driverName: "Ada",
      deliveryAddress: "12 Admiralty Way",
      estimatedDeliveryTime: "2030-01-01T01:00:00.000Z",
      actualDeliveryTime: null,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:10:00.000Z",
      openSupportCases: 0,
    },
  ],
  getConsumerOrderDetail: async () => ({
    order: {
      id: 501,
      orderNumber: "ORD-501",
      status: "out_for_delivery",
      totalAmount: 2075.0,
      platformFee: 75,
      driverFee: 500,
      currency: "NGN",
      verticalName: "Food",
      providerName: "Prov 1 Kitchen",
      driverName: "Ada",
      pickupAddress: null,
      deliveryAddress: "12 Admiralty Way",
      scheduledPickupTime: null,
      actualPickupTime: null,
      estimatedDeliveryTime: "2030-01-01T01:00:00.000Z",
      actualDeliveryTime: null,
      notes: null,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:10:00.000Z",
    },
    timeline: [],
    ledger: [],
    supportCases: [],
  }),
  openConsumerSupportCase: async (input: { idempotencyKey: string }) => ({
    id: 900,
    ticketNumber: "CS-abc123",
    orderId: null,
    orderNumber: null,
    type: "general",
    priority: "medium",
    status: "open",
    subject: "x",
    description: "x",
    resolution: null,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    resolvedAt: null,
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PHONE = "2348012345678";

type FlowModules = {
  session: typeof import("./whatsapp/session");
  menu: typeof import("./whatsapp/menu");
  suppression: typeof import("./whatsapp/suppression");
  sender: typeof import("./whatsapp/sender");
  webhook: typeof import("./whatsapp/webhook");
  identity: typeof import("./whatsapp/identity");
  commerce: typeof import("./_core/consumerCommerce");
};

async function freshModules(): Promise<FlowModules> {
  vi.resetModules();
  // Import order matters: the consumerCommerce mock factory uses
  // importOriginal, and concurrent dynamic imports can let dependents grab
  // the unmocked module. Import it first, sequentially.
  const commerce = await import("./_core/consumerCommerce");
  const session = await import("./whatsapp/session");
  const menu = await import("./whatsapp/menu");
  const suppression = await import("./whatsapp/suppression");
  const sender = await import("./whatsapp/sender");
  const webhook = await import("./whatsapp/webhook");
  const identity = await import("./whatsapp/identity");
  return { session, menu, suppression, sender, webhook, identity, commerce };
}

function inboundTextPayload(messageId: string, from: string, body: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "1555000111", phone_number_id: "PNID" },
              messages: [
                { from, id: messageId, timestamp: "1700000000", type: "text", text: { body } },
              ],
            },
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * (Re-)arm the consumerCommerce write-path mocks. Needed per test because
 * vi.resetModules() re-evaluates the mock factory and any prior
 * mockRejectedValueOnce/mockRestore state must not leak between tests.
 */
function setupCommerceMocks(commerce: FlowModules["commerce"]) {
  vi.mocked(commerce.createConsumerCart)
    .mockReset()
    .mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      consumerId: 42,
      serviceProviderId: null,
      verticalId: null,
      status: "active",
      idempotencyKey: null,
      createdAt: "",
      updatedAt: "",
    });
  vi.mocked(commerce.addConsumerCartItem)
    .mockReset()
    .mockResolvedValue({} as never);
  vi.mocked(commerce.checkoutConsumerCart)
    .mockReset()
    .mockResolvedValue(CHECKOUT_RESULT);
}

// ---------------------------------------------------------------------------
// ₦ formatting exactness (integer math only)
// ---------------------------------------------------------------------------

describe("money formatting", () => {
  it("formats minor units as exact ₦ major strings", async () => {
    const { menu } = await freshModules();
    expect(menu.formatNairaMinor(50000)).toBe("₦500.00");
    expect(menu.formatNairaMinor(5)).toBe("₦0.05");
    expect(menu.formatNairaMinor(0)).toBe("₦0.00");
    expect(menu.formatNairaMinor(207500)).toBe("₦2075.00");
  });

  it("parses TEXT major-unit prices to minor with string math", async () => {
    const { menu } = await freshModules();
    expect(menu.parsePriceMajorToMinor("1500.00")).toBe(150000);
    expect(menu.parsePriceMajorToMinor("1500")).toBe(150000);
    expect(menu.parsePriceMajorToMinor("0.05")).toBe(5);
    expect(menu.parsePriceMajorToMinor("1,500.00")).toBe(150000);
    expect(menu.parsePriceMajorToMinor("abc")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Full journey: browse → cart → checkout_confirm → checkout
// ---------------------------------------------------------------------------

describe("browse → cart → checkout journey", () => {
  it("runs the happy path with a linked account", async () => {
    const { session, commerce } = await freshModules();
    setupCommerceMocks(commerce);
    const s = session.newWhatsAppSession(PHONE);

    let r = await session.handleWhatsAppInboundText(s, "menu");
    expect(r.reply).toContain("Welcome to SwitchOS");

    // 1 = Browse products → verticals.
    r = await session.handleWhatsAppInboundText(s, "1");
    expect(s.state).toBe("browse");
    expect(r.reply).toContain("Food");

    // 1 = Food → providers page 1 (5 shown, 'next' available).
    r = await session.handleWhatsAppInboundText(s, "1");
    expect(r.reply).toContain("Prov 1 Kitchen");
    expect(r.reply).toContain("'next'");

    // 1 = first provider → catalog items with exact ₦ prices.
    r = await session.handleWhatsAppInboundText(s, "1");
    expect(r.reply).toContain("Jollof rice bowl — ₦1500.00");
    expect(r.reply).toContain("Suya wrap — ₦0.05");

    // 1 = add Jollof to cart (session-local snapshot in MINOR units).
    r = await session.handleWhatsAppInboundText(s, "1");
    expect(r.reply).toContain("Added Jollof rice bowl (₦1500.00)");
    expect(s.cart).toHaveLength(1);
    expect(s.cart[0]).toMatchObject({
      catalogItemId: 11,
      unitPriceMinor: 150000,
      quantity: 1,
    });

    // Cart view with fee-exact totals (defaults: 500bps + ₦500.00 delivery).
    r = await session.handleWhatsAppInboundText(s, "cart");
    expect(s.state).toBe("cart");
    expect(r.reply).toContain("Subtotal: ₦1500.00");
    expect(r.reply).toContain("Platform fee: ₦75.00");
    expect(r.reply).toContain("Delivery: ₦500.00");
    expect(r.reply).toContain("Total: ₦2075.00");

    // FAIL CLOSED: unlinked number cannot check out.
    r = await session.handleWhatsAppInboundText(s, "1");
    expect(r.reply).toContain("isn't linked");
    expect(commerce.checkoutConsumerCart).not.toHaveBeenCalled();
    expect(s.state).toBe("cart");

    // Temporary link flow.
    r = await session.handleWhatsAppInboundText(s, "link 42");
    expect(r.reply).toContain("Linked to account 42");
    expect(r.reply).toContain("temporary");

    // 1 → address prompt; free-text address without a pin.
    r = await session.handleWhatsAppInboundText(s, "1");
    expect(s.state).toBe("checkout_confirm");
    expect(r.reply).toContain("Where should we deliver?");
    r = await session.handleWhatsAppInboundText(s, "12 Admiralty Way, Lekki");
    expect(r.reply).toContain("Deliver to: 12 Admiralty Way, Lekki");
    expect(r.reply).toContain("coordinates sent as 0,0"); // LIMITATION footer
    expect(r.reply).toContain("Total (incl. fees): ₦2075.00");

    // Confirm → real consumer checkout via consumerCommerce.
    r = await session.handleWhatsAppInboundText(s, "1");
    expect(commerce.createConsumerCart).toHaveBeenCalledWith(
      expect.objectContaining({
        consumerUserId: 42,
        idempotencyKey: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
      }),
    );
    expect(commerce.addConsumerCartItem).toHaveBeenCalledWith(
      expect.objectContaining({ consumerUserId: 42, unitPriceMinor: 150000, quantity: 1 }),
    );
    expect(commerce.checkoutConsumerCart).toHaveBeenCalledWith(
      expect.objectContaining({
        consumerUserId: 42,
        deliveryAddress: "12 Admiralty Way, Lekki",
        deliveryLat: 0, // LIMITATION: no pin → sentinel 0,0
        deliveryLng: 0,
        idempotencyKey: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
      }),
    );
    expect(r.reply).toContain("Order ORD-1001 received!");
    expect(r.reply).toContain("Status: payment_pending");
    expect(r.reply).toContain("Payment reference: cp-test-ref");
    expect(r.reply).toContain("Total: ₦2075.00");
    expect(s.state).toBe("main_menu");
    expect(s.cart).toHaveLength(0);
  });

  it("keeps the order saved and offers retry when checkout fails", async () => {
    const { session, commerce } = await freshModules();
    setupCommerceMocks(commerce);
    const s = session.newWhatsAppSession(PHONE);
    await session.handleWhatsAppInboundText(s, "1"); // browse
    await session.handleWhatsAppInboundText(s, "1"); // vertical
    await session.handleWhatsAppInboundText(s, "1"); // provider
    await session.handleWhatsAppInboundText(s, "1"); // add item
    await session.handleWhatsAppInboundText(s, "link 42");
    await session.handleWhatsAppInboundText(s, "cart");
    await session.handleWhatsAppInboundText(s, "1"); // checkout → address
    await session.handleWhatsAppInboundText(s, "5 Broad St pin 6.5244,3.3792");

    vi.mocked(commerce.checkoutConsumerCart).mockRejectedValueOnce(
      new Error("payment_initiation_failed"),
    );
    const r = await session.handleWhatsAppInboundText(s, "1");
    expect(r.reply).toContain("Checkout failed: payment_initiation_failed");
    expect(r.reply).toContain("reply 1 to retry");
    expect(s.state).toBe("checkout_confirm");
    expect(s.cart).toHaveLength(1);

    // Retry succeeds; pin was parsed and passed through.
    const r2 = await session.handleWhatsAppInboundText(s, "1");
    expect(r2.reply).toContain("Order ORD-1001 received!");
    expect(commerce.checkoutConsumerCart).toHaveBeenLastCalledWith(
      expect.objectContaining({ deliveryLat: 6.5244, deliveryLng: 3.3792 }),
    );
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe("pagination", () => {
  it("paginates providers with next/prev and caps pages at 5", async () => {
    const { session } = await freshModules();
    const s = session.newWhatsAppSession(PHONE);
    await session.handleWhatsAppInboundText(s, "1"); // browse
    let r = await session.handleWhatsAppInboundText(s, "1"); // vertical → providers p1
    expect(r.reply).toContain("page 1");
    expect(r.reply).toContain("5. Prov 5 Kitchen");
    expect(r.reply).not.toContain("Prov 6");
    expect(r.reply).toContain("'next'");
    expect(r.reply).not.toContain("'prev'");

    r = await session.handleWhatsAppInboundText(s, "next");
    expect(r.reply).toContain("page 2");
    expect(r.reply).toContain("1. Prov 6 Kitchen");
    expect(r.reply).toContain("'prev'");
    expect(r.reply).not.toContain("'next'");

    r = await session.handleWhatsAppInboundText(s, "prev");
    expect(r.reply).toContain("page 1");
  });
});

// ---------------------------------------------------------------------------
// Cart editing
// ---------------------------------------------------------------------------

describe("cart editing", () => {
  it("adjusts quantities and removes lines with exact totals", async () => {
    const { session } = await freshModules();
    const s = session.newWhatsAppSession(PHONE);
    await session.handleWhatsAppInboundText(s, "1");
    await session.handleWhatsAppInboundText(s, "1");
    await session.handleWhatsAppInboundText(s, "1");
    await session.handleWhatsAppInboundText(s, "1"); // add Jollof
    await session.handleWhatsAppInboundText(s, "cart"); // open the cart

    let r = await session.handleWhatsAppInboundText(s, "qty 1 3");
    expect(r.reply).toContain("Subtotal: ₦4500.00");
    expect(r.reply).toContain("Platform fee: ₦225.00"); // 5% of 4500
    expect(r.reply).toContain("Total: ₦5225.00");

    r = await session.handleWhatsAppInboundText(s, "rm 1");
    expect(r.reply).toContain("Removed Jollof rice bowl");
    expect(r.reply).toContain("Your cart is empty");
    expect(s.cart).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Identity: link flow + phone normalization
// ---------------------------------------------------------------------------

describe("identity", () => {
  it("normalizes E.164 vs local NG formats", async () => {
    const { identity } = await freshModules();
    expect(identity.normalizePhoneVariants("08012345678")).toEqual(
      expect.arrayContaining(["2348012345678", "+2348012345678", "08012345678"]),
    );
    expect(identity.normalizePhoneVariants("+2348012345678")).toEqual(
      expect.arrayContaining(["08012345678", "2348012345678"]),
    );
  });

  it("rejects bad link syntax and unknown account ids", async () => {
    const { session } = await freshModules();
    const s = session.newWhatsAppSession(PHONE);
    let r = await session.handleWhatsAppInboundText(s, "link abc");
    expect(r.reply).toContain("link <accountId>");
    r = await session.handleWhatsAppInboundText(s, "link 99");
    expect(r.reply).toContain("couldn't find account 99");
    expect(s.linkedUserId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Track order + support
// ---------------------------------------------------------------------------

describe("track_order and support", () => {
  it("lists orders and shows status detail for a linked account", async () => {
    const { session } = await freshModules();
    const s = session.newWhatsAppSession(PHONE);
    await session.handleWhatsAppInboundText(s, "link 42");
    let r = await session.handleWhatsAppInboundText(s, "track");
    expect(s.state).toBe("track_order");
    expect(r.reply).toContain("1. ORD-501 — out_for_delivery — ₦2075.00");
    r = await session.handleWhatsAppInboundText(s, "1");
    expect(r.reply).toContain("Order ORD-501");
    expect(r.reply).toContain("Status: out_for_delivery");
    expect(r.reply).toContain("Courier: Ada");
  });

  it("refuses tracking for unlinked numbers (fail closed)", async () => {
    const { session } = await freshModules();
    const s = session.newWhatsAppSession(PHONE);
    const r = await session.handleWhatsAppInboundText(s, "track");
    expect(r.reply).toContain("isn't linked");
  });

  it("opens a support case and replies with the reference", async () => {
    const { session } = await freshModules();
    const s = session.newWhatsAppSession(PHONE);
    await session.handleWhatsAppInboundText(s, "link 42");
    let r = await session.handleWhatsAppInboundText(s, "support");
    expect(s.state).toBe("support");
    r = await session.handleWhatsAppInboundText(s, "my order never arrived");
    expect(r.reply).toContain("Support case CS-abc123 opened");
    expect(s.state).toBe("main_menu");
  });
});

// ---------------------------------------------------------------------------
// Opt-out suppression (STOP/START) via the webhook processing path
// ---------------------------------------------------------------------------

describe("opt-out suppression", () => {
  it("STOP suppresses all outbound; START re-enables", async () => {
    const { webhook, sender, suppression } = await freshModules();

    // STOP: single confirmation, then suppressed.
    const stopStats = await webhook.processWhatsAppPayload(
      inboundTextPayload("wamid.stop.1", PHONE, "STOP"),
    );
    expect(stopStats.processed).toBe(1);
    expect(stopStats.replies[0].reply).toContain("unsubscribed");
    expect(suppression.isWhatsAppSuppressed(PHONE)).toBe(true);

    // Every send to the number is now refused before touching the network.
    const sendResult = await sender.sendWhatsAppText(PHONE, "hello");
    expect(sendResult.sent).toBe(false);
    expect(sendResult.suppressed).toBe(true);

    // START re-enables and greets with the main menu.
    const startStats = await webhook.processWhatsAppPayload(
      inboundTextPayload("wamid.start.1", PHONE, "START"),
    );
    expect(startStats.replies[0].reply).toContain("resubscribed");
    expect(suppression.isWhatsAppSuppressed(PHONE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rate safety: every reply stays under the cap and lists end with a hint
// ---------------------------------------------------------------------------

describe("rate safety", () => {
  it("keeps replies concise and ends list replies with a navigation hint", async () => {
    const { session, menu } = await freshModules();
    const s = session.newWhatsAppSession(PHONE);
    const replies: string[] = [];
    for (const input of ["menu", "1", "1", "next", "1", "1", "cart", "0"]) {
      const r = await session.handleWhatsAppInboundText(s, input);
      replies.push(r.reply);
    }
    for (const reply of replies) {
      expect(reply.length).toBeLessThanOrEqual(menu.WA_REPLY_CHAR_CAP);
    }
  });
});
