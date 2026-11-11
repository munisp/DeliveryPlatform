/**
 * menu.ts — Numbered-text menu renderer for the WhatsApp consumer channel.
 *
 * Channel-agnostic, pure functions: build the ordered entries, render them
 * as a numbered text menu, and resolve a numeric reply back to an entry.
 * Adapted from the whatsappCommerce waMenu engine (numbered text fallback
 * path only — no interactive buttons/lists in this skeleton).
 *
 * The catalog items below are a STUB for the channel skeleton: real product
 * data is wired to the consumer marketplace read models in a later wave.
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
  ].join("\n");
}

/**
 * STUB catalog for the browse state. Real items come from the consumer
 * marketplace catalog in a later wave; the numbered-selection flow is what
 * this skeleton exercises.
 */
export const STUB_CATALOG_ITEMS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "stub-jollof-bowl", label: "Jollof rice bowl" },
  { id: "stub-suya-wrap", label: "Chicken suya wrap" },
  { id: "stub-cold-brew", label: "Cold brew coffee" },
];

/** Numbered stub catalog + add-to-cart hint. */
export function renderBrowseMenu(): string {
  const lines = STUB_CATALOG_ITEMS.map((item, index) => `${index + 1}. ${item.label}`);
  return [
    "Our current selection:",
    ...lines,
    "",
    "Reply with a number to add it to your cart, or 0 to go back.",
  ].join("\n");
}

/** Cart contents + numbered cart actions. */
export function renderCart(cart: readonly string[]): string {
  const items =
    cart.length === 0
      ? ["Your cart is empty."]
      : ["Your cart:", ...cart.map((item, index) => `${index + 1}. ${item}`)];
  return [
    ...items,
    "",
    cart.length === 0
      ? "Reply 0 to go back to the menu."
      : "Reply 1 to checkout, or 0 to go back to the menu.",
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
