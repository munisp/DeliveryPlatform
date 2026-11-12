/**
 * menu.ts — Numbered-text menu renderer for the WhatsApp consumer channel.
 *
 * Channel-agnostic, pure functions: build the ordered entries, render them
 * as a numbered text menu, and resolve a numeric reply back to an entry.
 * Adapted from the whatsappCommerce waMenu engine (numbered text fallback
 * path only — no interactive buttons/lists).
 *
 * P2: the P1 stub catalog is gone — browse/cart rendering now formats REAL
 * catalog/provider/cart data (flows.ts). Money rule (P1 contract): all
 * amounts are MINOR units (kobo) rendered as ₦ major units with integer
 * math only (BigInt divide/mod), never floats. Catalog prices arrive as
 * TEXT major units and are parsed with parsePriceMajorToMinor (string
 * math, never float).
 */

/** State ids a main-menu selection can move the session into. */
export type WhatsAppMenuTarget =
  | "browse"
  | "cart"
  | "checkout_confirm"
  | "track_order"
  | "support";

export interface WhatsAppMenuEntry {
  n: number;
  id: WhatsAppMenuTarget;
  label: string;
}

const MAIN_MENU_LABELS: Array<{ id: WhatsAppMenuTarget; label: string }> = [
  { id: "browse", label: "Browse products" },
  { id: "cart", label: "View cart" },
  { id: "checkout_confirm", label: "Checkout" },
  { id: "track_order", label: "Track an order" },
  { id: "support", label: "Talk to support" },
];

/** Ordered, numbered main-menu entries (numbered from 1). */
export function buildMainMenuEntries(): WhatsAppMenuEntry[] {
  return MAIN_MENU_LABELS.map((entry, index) => ({ ...entry, n: index + 1 }));
}

/** Greeting + numbered list + reply hint. */
export function renderMainMenu(): string {
  const lines = buildMainMenuEntries().map((entry) => `${entry.n}. ${entry.label}`);
  return [
    "Welcome to SwitchOS! What would you like to do?",
    ...lines,
    "",
    "Reply with a number to choose an option.",
    "Tips: 'link <accountId>' links this number for checkout; 'stop' opts out.",
  ].join("\n");
}

/** Parse a numeric reply into a 1-based selection, or null when invalid. */
export function resolveNumberedSelection(input: string, max: number): number | null {
  const trimmed = input.trim();
  if (!/^\d{1,2}$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  return n >= 1 && n <= max ? n : null;
}

/** Keywords that always re-open the main menu. */
const MENU_KEYWORDS = new Set(["menu", "hi", "hello", "start", "restart", "help"]);

export function isMenuKeyword(text: string): boolean {
  return MENU_KEYWORDS.has(text.trim().toLowerCase());
}

/** Hard cap for outbound replies (rate safety, P2 spec). */
export const WA_REPLY_CHAR_CAP = 990;

/** Shared trailing hint so flow replies end with a menu escape hatch. */
export const MENU_HINT = "Reply with a number, or 'menu' for the main menu.";

/** Cap a reply at WA_REPLY_CHAR_CAP so lists can never blow up the send. */
export function capReply(text: string): string {
  return text.length > WA_REPLY_CHAR_CAP
    ? `${text.slice(0, WA_REPLY_CHAR_CAP - 3)}...`
    : text;
}

// ---------------------------------------------------------------------------
// Money (minor units in, exact ₦ string out; integer math only)
// ---------------------------------------------------------------------------

/** 50000 -> "₦500.00". Negative inputs are clamped to ₦0.00 (display only). */
export function formatNairaMinor(minor: number | bigint): string {
  let value = BigInt(minor);
  if (value < 0n) value = 0n;
  return `₦${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}

/**
 * Parse a TEXT major-unit catalog price ("1500.00", "1500", "0.05", with
 * optional thousand separators) into minor units using string math only.
 * Returns null when the text is not a plain non-negative decimal.
 */
export function parsePriceMajorToMinor(text: string): number | null {
  const cleaned = text.trim().replace(/[,₦\s]/g, "");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fracText = (match[2] ?? "").padEnd(2, "0") || "00";
  const minor = whole * 100n + BigInt(fracText);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(minor);
}

// ---------------------------------------------------------------------------
// List renderers (browse flow). Inputs are plain rows; no schema imports.
// ---------------------------------------------------------------------------

export function renderVerticalList(verticals: Array<{ name: string }>): string {
  const lines = verticals.map((v, i) => `${i + 1}. ${v.name}`).join("\n");
  return capReply(`What are you looking for?\n${lines}\n\n${MENU_HINT}`);
}

export function renderProviderPage(input: {
  verticalName: string;
  providers: Array<{
    businessName: string;
    name: string;
    address: string | null;
    rating: string;
  }>;
  page: number;
  hasMore: boolean;
}): string {
  const lines = input.providers
    .map((p, i) => {
      const label = p.businessName || p.name;
      const address = p.address ? ` — ${p.address}` : "";
      return `${i + 1}. ${label}${address} (${p.rating}★)`;
    })
    .join("\n");
  const nav = [
    `Reply 1-${input.providers.length} to view a menu`,
    input.hasMore ? "'next'" : null,
    input.page > 0 ? "'prev'" : null,
    "0 back",
  ]
    .filter(Boolean)
    .join(", ");
  return capReply(
    `${input.verticalName} providers (page ${input.page + 1}):\n${lines}\n\n${nav}.`,
  );
}

export function renderCatalogPage(input: {
  providerName: string;
  items: Array<{ itemName: string; priceMinor: number | null }>;
  page: number;
  hasMore: boolean;
}): string {
  const lines = input.items
    .map((item, i) => {
      const price =
        item.priceMinor === null
          ? "price unavailable"
          : formatNairaMinor(item.priceMinor);
      return `${i + 1}. ${item.itemName} — ${price}`;
    })
    .join("\n");
  const nav = [
    `Reply 1-${input.items.length} to add to cart`,
    input.hasMore ? "'next'" : null,
    input.page > 0 ? "'prev'" : null,
    "0 back",
  ]
    .filter(Boolean)
    .join(", ");
  return capReply(
    `${input.providerName} menu (page ${input.page + 1}):\n${lines}\n\n${nav}.`,
  );
}
