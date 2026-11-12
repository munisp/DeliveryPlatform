import {
  addConsumerCartItem,
  checkoutConsumerCart,
  computePlatformFeeMinor,
  createConsumerCart,
  resolveConsumerFeeConfig,
} from "../_core/consumerCommerce";
import {
  listConsumerCatalog,
  listConsumerProviders,
  listConsumerVerticals,
  type ConsumerCatalogItem,
  type ConsumerProvider,
} from "../_core/consumerCatalog";
import {
  getConsumerOrderDetail,
  listConsumerOrders,
  openConsumerSupportCase,
} from "../_core/consumerQueries";
import { findUserIdByPhone, userExists } from "./identity";
import {
  buildMainMenuEntries,
  capReply,
  formatNairaMinor,
  isMenuKeyword,
  MENU_HINT,
  parsePriceMajorToMinor,
  renderCatalogPage,
  renderMainMenu,
  renderProviderPage,
  renderVerticalList,
  resolveNumberedSelection,
} from "./menu";
import type {
  WhatsAppInboundContext,
  WhatsAppSession,
  SessionTransition,
} from "./session";

/**
 * WhatsApp consumer text flows (P2-B): browse → cart → checkout, order
 * tracking and support on top of the real consumer commerce layer.
 *
 * Business logic is NEVER duplicated here: catalog reads come from
 * server/_core/consumerCatalog.ts, checkout/cart writes and fee math from
 * server/_core/consumerCommerce.ts, and order/support reads from
 * server/_core/consumerQueries.ts.
 *
 * Identity (see identity.ts): checkout, tracking and support FAIL CLOSED
 * for numbers that cannot be resolved to a public.users.id — either by
 * users.phone match (E.164/local-NG normalized) or by the temporary,
 * unverified, session-local "link <accountId>" binding. Browse and cart
 * work unlinked (the cart is session-local MINOR-unit snapshots until
 * checkout, when a real consumer cart is created via consumerCommerce).
 *
 * Idempotency: cart/checkout/support writes use deterministic keys
 * (wa-cart-<phone>-v<n> / wa-checkout-<phone>-v<n> / wa-sup-<phone>-<seq>)
 * matching ^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$; cartVersion bumps on every
 * cart mutation and after a successful checkout, so a retried confirm with
 * an unchanged cart replays the stored checkout instead of double-charging.
 * Webhook-level wamid replay is already deduped upstream (dedupe.ts).
 *
 * Money: catalog priceMajor TEXT is parsed to MINOR units with string math
 * (parsePriceMajorToMinor); all display goes through formatNairaMinor
 * (integer math, never float).
 *
 * LIMITATION: delivery coordinates. WhatsApp text has no native location
 * payload here, so we parse an optional free-text pin ("pin 6.5244,3.3792").
 * When absent, checkout is called with deliveryLat/deliveryLng = 0,0 (the
 * Gulf of Guinea — a sentinel, NOT a real address) and the reply footer says
 * the courier will call to confirm. A location-message handler is a
 * follow-up wave item.
 */

const PAGE_SIZE = 5;

const LINK_PROMPT =
  "This WhatsApp number isn't linked to a SwitchOS account, so I can't do that yet. " +
  "Reply 'link <accountId>' with your numeric account ID to continue. " +
  "(Temporary, unverified linking until phone signup lands — browsing and cart work without it.)";

const GENERIC_ERROR_REPLY =
  "Sorry, something went wrong on our side. Please try again in a moment, or reply 'menu' to start over.";

function result(session: WhatsAppSession, reply: string): SessionTransition {
  return { session, reply: capReply(reply) };
}

function bumpCartVersion(session: WhatsAppSession): void {
  session.data = {
    ...(session.data ?? {}),
    cartVersion: (session.data?.cartVersion ?? 0) + 1,
  };
}

function cartCount(session: WhatsAppSession): number {
  return session.cart.reduce((sum, line) => sum + line.quantity, 0);
}

function cartSubtotalMinor(session: WhatsAppSession): number {
  return session.cart.reduce(
    (sum, line) => sum + line.unitPriceMinor * line.quantity,
    0,
  );
}

/** Resolve the session's consumer id (cached phone match). Throws on DB error. */
async function resolveIdentity(session: WhatsAppSession): Promise<number | null> {
  if (session.linkedUserId !== null) return session.linkedUserId;
  const id = await findUserIdByPhone(session.phone);
  if (id !== null) session.linkedUserId = id;
  return id;
}

/**
 * Fail-closed gate for account-scoped operations (checkout/track/support).
 * Returns the user id, or null after setting the refusal reply on `out`.
 */
async function requireLinkedUser(
  session: WhatsAppSession,
): Promise<{ userId: number } | { refusal: string }> {
  let userId: number | null;
  try {
    userId = await resolveIdentity(session);
  } catch {
    return {
      refusal:
        "I couldn't verify your account right now. Please try again in a moment.",
    };
  }
  if (userId === null) return { refusal: LINK_PROMPT };
  return { userId };
}

// ---------------------------------------------------------------------------
// Global commands (available in every state)
// ---------------------------------------------------------------------------

async function handleGlobalCommand(
  session: WhatsAppSession,
  text: string,
): Promise<SessionTransition | null> {
  const lower = text.toLowerCase();

  if (isMenuKeyword(text)) {
    const linkedUserId = session.linkedUserId; // link survives a menu reset
    session.state = "main_menu";
    session.cart = [];
    session.data = {};
    session.linkedUserId = linkedUserId;
    return result(session, renderMainMenu());
  }

  const linkMatch = /^link\s+(\d{1,12})$/i.exec(text);
  if (linkMatch) {
    const accountId = Number.parseInt(linkMatch[1], 10);
    try {
      if (!(await userExists(accountId))) {
        return result(
          session,
          `I couldn't find account ${accountId}. Check the number and try again, e.g. 'link 42'.`,
        );
      }
    } catch {
      return result(
        session,
        "I couldn't verify that account right now. Please try again in a moment.",
      );
    }
    session.linkedUserId = accountId;
    return result(
      session,
      `Linked to account ${accountId}. NOTE: this link is temporary and unverified — it only lasts while this chat session is active. ${MENU_HINT}`,
    );
  }
  if (/^link\b/i.test(lower)) {
    return result(
      session,
      `To link this number, reply 'link <accountId>' with your numeric account ID, e.g. 'link 42'.`,
    );
  }

  if (lower === "cart") {
    session.state = "cart";
    return result(session, renderCartView(session));
  }
  if (lower === "track") {
    session.state = "track_order";
    return renderOrderListResult(session);
  }
  if (lower === "support") {
    session.state = "support";
    return result(session, supportPrompt());
  }

  return null;
}

function supportPrompt(): string {
  return `Describe your issue in one message and I'll open a support case for you.\n\nReply with your message, or 0 to cancel.`;
}

// ---------------------------------------------------------------------------
// Browse flow
// ---------------------------------------------------------------------------

async function showVerticals(session: WhatsAppSession): Promise<SessionTransition> {
  const verticals = await listConsumerVerticals();
  if (verticals.length === 0) {
    session.state = "main_menu";
    return result(
      session,
      `No services are available right now. Please try again later.\n\n${MENU_HINT}`,
    );
  }
  session.state = "browse";
  session.data = {
    ...(session.data ?? {}),
    browseStage: "verticals",
    verticals,
    page: 0,
  };
  return result(session, renderVerticalList(verticals));
}

async function showProviderPage(
  session: WhatsAppSession,
  page: number,
): Promise<SessionTransition> {
  const verticalId = session.data?.verticalId;
  const verticalName = session.data?.verticalName ?? "Services";
  if (!verticalId) return showVerticals(session);
  // Fetch one extra row to know whether a next page exists.
  const rows = await listConsumerProviders({
    verticalId,
    limit: PAGE_SIZE + 1,
    offset: page * PAGE_SIZE,
  });
  const hasMore = rows.length > PAGE_SIZE;
  const providers = rows.slice(0, PAGE_SIZE);
  if (providers.length === 0) {
    if (page === 0) {
      return result(
        session,
        `No providers are available in ${verticalName} yet.\n\nReply 0 to go back, or 'menu' for the main menu.`,
      );
    }
    return showProviderPage(session, page - 1);
  }
  session.data = {
    ...(session.data ?? {}),
    browseStage: "providers",
    providers,
    page,
  };
  return result(
    session,
    renderProviderPage({ verticalName, providers, page, hasMore }),
  );
}

async function showCatalogPage(
  session: WhatsAppSession,
  page: number,
): Promise<SessionTransition> {
  const providerId = session.data?.providerId;
  const providerName = session.data?.providerName ?? "Provider";
  if (!providerId) return showProviderPage(session, 0);
  const rows = await listConsumerCatalog({
    providerId,
    limit: PAGE_SIZE + 1,
    offset: page * PAGE_SIZE,
  });
  const hasMore = rows.length > PAGE_SIZE;
  const items = rows.slice(0, PAGE_SIZE);
  if (items.length === 0) {
    if (page === 0) {
      return result(
        session,
        `${providerName} has no items available right now.\n\nReply 0 to go back, or 'menu' for the main menu.`,
      );
    }
    return showCatalogPage(session, page - 1);
  }
  session.data = { ...(session.data ?? {}), browseStage: "items", items, page };
  return result(
    session,
    renderCatalogPage({
      providerName,
      items: items.map((item) => ({
        itemName: item.itemName,
        priceMinor: parsePriceMajorToMinor(item.priceMajor),
      })),
      page,
      hasMore,
    }),
  );
}

function addItemToCart(session: WhatsAppSession, item: ConsumerCatalogItem): string {
  const priceMinor = parsePriceMajorToMinor(item.priceMajor);
  if (priceMinor === null) {
    return `Sorry, "${item.itemName}" can't be ordered right now (bad price). Pick another item, or 0 to go back.`;
  }
  const existing = session.cart.find((line) => line.catalogItemId === item.id);
  if (existing) {
    existing.quantity = Math.min(999, existing.quantity + 1);
  } else {
    session.cart.push({
      catalogItemId: item.id,
      name: item.itemName,
      unitPriceMinor: priceMinor,
      quantity: 1,
    });
  }
  bumpCartVersion(session);
  return (
    `Added ${item.itemName} (${formatNairaMinor(priceMinor)}). ` +
    `Cart: ${cartCount(session)} item(s), ${formatNairaMinor(cartSubtotalMinor(session))} + fees.\n\n` +
    `Reply with another number to add more, 'cart' to review, 'next' for more items, or 0 to go back.`
  );
}

async function handleBrowseState(
  session: WhatsAppSession,
  text: string,
): Promise<SessionTransition> {
  const stage = session.data?.browseStage ?? "verticals";
  const lower = text.toLowerCase();

  if (stage === "verticals") {
    if (text === "0") {
      session.state = "main_menu";
      return result(session, renderMainMenu());
    }
    const pick = /^\d+$/.test(text) ? Number.parseInt(text, 10) - 1 : -1;
    const vertical = session.data?.verticals?.[pick];
    if (!vertical) {
      return result(session, renderVerticalList(session.data?.verticals ?? []));
    }
    session.data = {
      ...(session.data ?? {}),
      verticalId: vertical.id,
      verticalName: vertical.name,
    };
    return showProviderPage(session, 0);
  }

  if (stage === "providers") {
    if (text === "0") return showVerticals(session);
    if (lower === "next") return showProviderPage(session, (session.data?.page ?? 0) + 1);
    if (lower === "prev") return showProviderPage(session, Math.max(0, (session.data?.page ?? 0) - 1));
    const pick = /^\d+$/.test(text) ? Number.parseInt(text, 10) - 1 : -1;
    const provider: ConsumerProvider | undefined = session.data?.providers?.[pick];
    if (!provider) {
      return showProviderPage(session, session.data?.page ?? 0);
    }
    session.data = {
      ...(session.data ?? {}),
      providerId: provider.id,
      providerName: provider.businessName || provider.name,
    };
    return showCatalogPage(session, 0);
  }

  // stage === "items"
  if (text === "0") return showProviderPage(session, session.data?.page ?? 0);
  if (lower === "next") return showCatalogPage(session, (session.data?.page ?? 0) + 1);
  if (lower === "prev") return showCatalogPage(session, Math.max(0, (session.data?.page ?? 0) - 1));
  const pick = /^\d+$/.test(text) ? Number.parseInt(text, 10) - 1 : -1;
  const item = session.data?.items?.[pick];
  if (!item) {
    return showCatalogPage(session, session.data?.page ?? 0);
  }
  return result(session, addItemToCart(session, item));
}

// ---------------------------------------------------------------------------
// Cart + checkout flow
// ---------------------------------------------------------------------------

function renderCartView(session: WhatsAppSession): string {
  if (session.cart.length === 0) {
    return `Your cart is empty. Reply 1 on the main menu to browse services.\n\n${MENU_HINT}`;
  }
  const lines = session.cart
    .map(
      (line, i) =>
        `${i + 1}. ${line.name} ×${line.quantity} — ${formatNairaMinor(
          line.unitPriceMinor * line.quantity,
        )}`,
    )
    .join("\n");
  const feeConfig = resolveConsumerFeeConfig();
  const subtotal = cartSubtotalMinor(session);
  const platformFee = computePlatformFeeMinor(subtotal, feeConfig.platformFeeBps);
  const total = subtotal + platformFee + feeConfig.deliveryFeeMinor;
  return (
    `Your cart:\n${lines}\n\n` +
    `Subtotal: ${formatNairaMinor(subtotal)}\n` +
    `Platform fee: ${formatNairaMinor(platformFee)}\n` +
    `Delivery: ${formatNairaMinor(feeConfig.deliveryFeeMinor)}\n` +
    `Total: ${formatNairaMinor(total)}\n\n` +
    `Reply 'qty <n> <count>' to change a quantity, 'rm <n>' to remove an item, 1 to checkout, or 0 for the menu.`
  );
}

async function handleCartState(
  session: WhatsAppSession,
  text: string,
): Promise<SessionTransition> {
  const qtyMatch = /^qty\s+(\d+)\s+(\d{1,3})$/i.exec(text);
  if (qtyMatch) {
    const line = session.cart[Number.parseInt(qtyMatch[1], 10) - 1];
    const qty = Number.parseInt(qtyMatch[2], 10);
    if (!line || qty < 1) {
      return result(session, `I couldn't apply that. ${renderCartView(session)}`);
    }
    line.quantity = qty;
    bumpCartVersion(session);
    return result(session, `Updated. ${renderCartView(session)}`);
  }
  const rmMatch = /^rm\s+(\d+)$/i.exec(text);
  if (rmMatch) {
    const index = Number.parseInt(rmMatch[1], 10) - 1;
    if (index < 0 || index >= session.cart.length) {
      return result(session, `I couldn't apply that. ${renderCartView(session)}`);
    }
    const [removed] = session.cart.splice(index, 1);
    bumpCartVersion(session);
    return result(session, `Removed ${removed.name}. ${renderCartView(session)}`);
  }
  if (text === "1") {
    if (session.cart.length === 0) {
      return result(session, `Your cart is empty — nothing to check out.\n\n${MENU_HINT}`);
    }
    const gate = await requireLinkedUser(session);
    if ("refusal" in gate) {
      // FAIL CLOSED: unlinked numbers can browse/cart but cannot checkout.
      return result(session, gate.refusal);
    }
    session.state = "checkout_confirm";
    session.data = {
      ...(session.data ?? {}),
      checkoutStage: "address",
      deliveryAddress: undefined,
      deliveryLat: null,
      deliveryLng: null,
    };
    return result(
      session,
      `Where should we deliver?\n\n` +
        `Reply with your delivery address as text. Add a pin for accuracy, e.g. "12 Admiralty Way, Lekki pin 6.5244,3.3792".\n\n` +
        `Reply 0 to cancel.`,
    );
  }
  if (text === "0") {
    session.state = "main_menu";
    return result(session, renderMainMenu());
  }
  return result(session, renderCartView(session));
}

/** Parse an optional "pin <lat>,<lng>" suffix out of free-text address. */
function parseAddressWithPin(text: string): {
  address: string;
  lat: number | null;
  lng: number | null;
} {
  const pinMatch = /pin\s+(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/i.exec(text);
  if (!pinMatch) return { address: text.trim(), lat: null, lng: null };
  const lat = Number(pinMatch[1]);
  const lng = Number(pinMatch[2]);
  const address = text.replace(pinMatch[0], "").trim();
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) {
    return { address: text.trim(), lat: null, lng: null };
  }
  return { address, lat, lng };
}

function renderCheckoutSummary(session: WhatsAppSession): string {
  const feeConfig = resolveConsumerFeeConfig();
  const subtotal = cartSubtotalMinor(session);
  const platformFee = computePlatformFeeMinor(subtotal, feeConfig.platformFeeBps);
  const total = subtotal + platformFee + feeConfig.deliveryFeeMinor;
  const lines = session.cart
    .map(
      (line, i) =>
        `${i + 1}. ${line.name} ×${line.quantity} — ${formatNairaMinor(
          line.unitPriceMinor * line.quantity,
        )}`,
    )
    .join("\n");
  const pinNote =
    session.data?.deliveryLat == null
      ? "\n(Note: no delivery pin — coordinates sent as 0,0; the courier will call to confirm the exact spot.)"
      : "";
  return (
    `Order summary:\n${lines}\n\n` +
    `Total (incl. fees): ${formatNairaMinor(total)}\n` +
    `Deliver to: ${session.data?.deliveryAddress ?? ""}${pinNote}\n\n` +
    `Reply 1 to confirm and pay, or 0 to cancel.`
  );
}

async function runCheckout(session: WhatsAppSession): Promise<string> {
  const userId = session.linkedUserId;
  if (userId === null) return LINK_PROMPT; // unreachable; gated upstream
  const version = session.data?.cartVersion ?? 1;
  const phoneKey = session.phone.replace(/[^\d]/g, "");
  const cart = await createConsumerCart({
    consumerUserId: userId,
    idempotencyKey: `wa-cart-${phoneKey}-v${version}`,
  });
  for (const line of session.cart) {
    await addConsumerCartItem({
      consumerUserId: userId,
      cartId: cart.id,
      catalogItemId: line.catalogItemId,
      name: line.name,
      unitPriceMinor: line.unitPriceMinor,
      quantity: line.quantity,
      modifiers: [],
    });
  }
  // LIMITATION: when the consumer gave no pin we pass 0,0 (documented
  // sentinel — see file header), never a guessed coordinate.
  const checkout = await checkoutConsumerCart({
    consumerUserId: userId,
    cartId: cart.id,
    idempotencyKey: `wa-checkout-${phoneKey}-v${version}`,
    deliveryAddress: session.data?.deliveryAddress ?? "",
    deliveryLat: session.data?.deliveryLat ?? 0,
    deliveryLng: session.data?.deliveryLng ?? 0,
  });
  const pinNote =
    session.data?.deliveryLat == null
      ? "\n(Note: no delivery pin — coordinates sent as 0,0; the courier will call to confirm the exact spot.)"
      : "";
  session.cart = [];
  session.state = "main_menu";
  bumpCartVersion(session); // next checkout uses fresh idempotency keys
  return (
    `Order ${checkout.orderNumber} received!\n` +
    `Status: ${checkout.status}\n` +
    `Total: ${formatNairaMinor(checkout.totalMinor)}\n` +
    `Payment reference: ${checkout.paymentReference ?? "pending"}\n` +
    `We'll message you here when the provider confirms.${pinNote}\n\n${MENU_HINT}`
  );
}

async function handleCheckoutConfirmState(
  session: WhatsAppSession,
  text: string,
): Promise<SessionTransition> {
  const stage = session.data?.checkoutStage ?? "address";

  if (text === "0") {
    session.state = "cart";
    return result(session, `Checkout cancelled. ${renderCartView(session)}`);
  }

  if (stage === "address") {
    const { address, lat, lng } = parseAddressWithPin(text);
    if (address.length < 3 || address.length > 500) {
      return result(
        session,
        `That address doesn't look right — please reply with your delivery address as text (3-500 characters), optionally with "pin <lat>,<lng>". Reply 0 to cancel.`,
      );
    }
    session.data = {
      ...(session.data ?? {}),
      checkoutStage: "confirm",
      deliveryAddress: address,
      deliveryLat: lat,
      deliveryLng: lng,
    };
    return result(session, renderCheckoutSummary(session));
  }

  // stage === "confirm"
  if (text !== "1") {
    return result(session, renderCheckoutSummary(session));
  }
  try {
    return result(session, await runCheckout(session));
  } catch (error) {
    const message = error instanceof Error ? error.message : "checkout_failed";
    return result(
      session,
      `Checkout failed: ${message}. Your order is saved — reply 1 to retry, or 0 to go back to your cart.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Track + support flows
// ---------------------------------------------------------------------------

async function renderOrderListResult(
  session: WhatsAppSession,
): Promise<SessionTransition> {
  const gate = await requireLinkedUser(session);
  if ("refusal" in gate) {
    session.state = "main_menu";
    return result(session, gate.refusal);
  }
  let orders: Awaited<ReturnType<typeof listConsumerOrders>>;
  try {
    orders = await listConsumerOrders(gate.userId, PAGE_SIZE);
  } catch {
    session.state = "main_menu";
    return result(session, GENERIC_ERROR_REPLY);
  }
  if (orders.length === 0) {
    session.state = "main_menu";
    return result(session, `You have no orders yet.\n\n${MENU_HINT}`);
  }
  session.state = "track_order";
  session.data = { ...(session.data ?? {}), orders };
  const lines = orders
    .map(
      (order, i) =>
        `${i + 1}. ${order.orderNumber} — ${order.status} — ₦${order.totalAmount.toFixed(2)}`,
    )
    .join("\n");
  return result(
    session,
    `Your recent orders:\n${lines}\n\nReply with a number for details, or 0 for the menu.`,
  );
}

async function handleTrackOrderState(
  session: WhatsAppSession,
  text: string,
): Promise<SessionTransition> {
  if (text === "0") {
    session.state = "main_menu";
    return result(session, renderMainMenu());
  }
  const pick = /^\d+$/.test(text) ? Number.parseInt(text, 10) - 1 : -1;
  const order = session.data?.orders?.[pick];
  if (!order) {
    return renderOrderListResult(session);
  }
  const gate = await requireLinkedUser(session);
  if ("refusal" in gate) return result(session, gate.refusal);
  try {
    const detail = await getConsumerOrderDetail(gate.userId, order.id);
    if (!detail) {
      return result(session, `Order ${order.orderNumber} was not found.\n\n${MENU_HINT}`);
    }
    const o = detail.order;
    const lines = [
      `Order ${o.orderNumber}`,
      `Status: ${o.status}`,
      `Total: ₦${o.totalAmount.toFixed(2)}`,
      o.providerName ? `Provider: ${o.providerName}` : null,
      o.driverName ? `Courier: ${o.driverName}` : null,
      o.estimatedDeliveryTime && !o.actualDeliveryTime
        ? `ETA: ${o.estimatedDeliveryTime}`
        : null,
      o.actualDeliveryTime ? `Delivered: ${o.actualDeliveryTime}` : null,
    ].filter(Boolean);
    session.state = "main_menu";
    return result(session, `${lines.join("\n")}\n\n${MENU_HINT}`);
  } catch {
    session.state = "main_menu";
    return result(session, GENERIC_ERROR_REPLY);
  }
}

async function handleSupportState(
  session: WhatsAppSession,
  text: string,
  ctx: WhatsAppInboundContext,
): Promise<SessionTransition> {
  if (text === "0") {
    session.state = "main_menu";
    return result(session, renderMainMenu());
  }
  const gate = await requireLinkedUser(session);
  if ("refusal" in gate) {
    session.state = "main_menu";
    return result(session, gate.refusal);
  }
  const description = text.trim().slice(0, 2000);
  if (description.length < 3) {
    return result(session, supportPrompt());
  }
  const seq = (session.data?.supportSeq ?? 0) + 1;
  try {
    const supportCase = await openConsumerSupportCase({
      consumerUserId: gate.userId,
      orderId: null,
      type: "general",
      subject: description.slice(0, 60),
      description,
      // Deterministic per session+sequence; wamid replays never reach here
      // (dedupe.ts), so a repeated text is a deliberate second case.
      idempotencyKey: `wa-sup-${session.phone.replace(/[^\d]/g, "")}-${seq}`,
    });
    session.data = { ...(session.data ?? {}), supportSeq: seq };
    session.state = "main_menu";
    return result(
      session,
      `Support case ${supportCase.ticketNumber} opened. Our team will reach out on this number.\n\n${MENU_HINT}`,
    );
  } catch {
    session.state = "main_menu";
    return result(session, GENERIC_ERROR_REPLY);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runWhatsAppFlow(
  session: WhatsAppSession,
  rawText: string,
  ctx: WhatsAppInboundContext,
): Promise<SessionTransition> {
  const text = rawText.trim();
  if (text.length === 0) {
    return result(session, `I didn't catch that.\n\n${renderMainMenu()}`);
  }

  const globalResult = await handleGlobalCommand(session, text);
  if (globalResult) return globalResult;

  try {
    switch (session.state) {
      case "main_menu": {
        const entries = buildMainMenuEntries();
        const n = resolveNumberedSelection(text, entries.length);
        const selection = n === null ? null : entries[n - 1];
        if (!selection) {
          return result(
            session,
            `Sorry, I didn't understand "${text.slice(0, 80)}".\n\n${renderMainMenu()}`,
          );
        }
        if (selection.id === "browse") return showVerticals(session);
        if (selection.id === "cart") {
          session.state = "cart";
          return result(session, renderCartView(session));
        }
        if (selection.id === "checkout_confirm") {
          // Menu deep-link to checkout behaves like "1" in the cart state.
          session.state = "cart";
          return handleCartState(session, "1");
        }
        if (selection.id === "track_order") return renderOrderListResult(session);
        session.state = "support";
        return result(session, supportPrompt());
      }
      case "browse":
        return await handleBrowseState(session, text);
      case "cart":
        return await handleCartState(session, text);
      case "checkout_confirm":
        return await handleCheckoutConfirmState(session, text);
      case "track_order":
        return await handleTrackOrderState(session, text);
      case "support":
        return await handleSupportState(session, text, ctx);
    }
  } catch (error) {
    console.error(
      `[whatsapp] flow error in state ${session.state} for ${session.phone}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return result(session, GENERIC_ERROR_REPLY);
  }
}
