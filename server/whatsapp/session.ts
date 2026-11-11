/**
 * session.ts — WhatsApp consumer conversational session state machine.
 *
 * Tracks where a customer is inside the numbered-menu flow so multi-step
 * interactions (browse → cart → checkout) survive across webhook deliveries.
 * Adapted from the whatsappCommerce chatSession engine; states here are the
 * DeliveryPlatform consumer-parity set:
 *
 *   main_menu → browse → cart → checkout_confirm
 *                  ↘ track_order / support (leaf states, return to menu)
 *
 * LIMITATION: session persistence is an in-process Map with TTL — there is
 * no suitable existing Postgres table in this schema for conversational
 * sessions (consumer_processed_events is an idempotency ledger, not session
 * state), and this program forbids schema changes from this module. Sessions
 * therefore do NOT survive a pod restart or scale-out: each replica holds
 * its own copy and a customer pinned to another replica starts over at the
 * main menu. Acceptable for the channel skeleton; replace with a real table
 * (or the shared Redis cache) before production rollout.
 */

import {
  isMenuKeyword,
  renderBrowseMenu,
  renderCart,
  renderMainMenu,
  resolveNumberedSelection,
  STUB_CATALOG_ITEMS,
  type WhatsAppMenuTarget,
} from "./menu";

export type WhatsAppSessionState =
  | "main_menu"
  | "browse"
  | "cart"
  | "checkout_confirm"
  | "track_order"
  | "support";

export interface WhatsAppSession {
  phone: string;
  state: WhatsAppSessionState;
  /** Stub-catalog item labels added from the browse state. */
  cart: string[];
  /** Free-form flow data (e.g. last tracking reference typed). */
  data?: Record<string, unknown>;
  updatedAt: number;
}

/** Sessions idle longer than this are pruned on next access. */
export const WA_SESSION_TTL_MS = 30 * 60 * 1000;

const sessions = new Map<string, WhatsAppSession>();

export function newWhatsAppSession(phone: string): WhatsAppSession {
  return { phone, state: "main_menu", cart: [], updatedAt: Date.now() };
}

export async function getWhatsAppSession(phone: string): Promise<WhatsAppSession | null> {
  const session = sessions.get(phone);
  if (!session) return null;
  if (session.updatedAt + WA_SESSION_TTL_MS <= Date.now()) {
    sessions.delete(phone);
    return null;
  }
  return session;
}

export async function saveWhatsAppSession(session: WhatsAppSession): Promise<void> {
  session.updatedAt = Date.now();
  sessions.set(session.phone, session);
}

export async function clearWhatsAppSession(phone: string): Promise<void> {
  sessions.delete(phone);
}

/** Test helper: wipe the in-memory session store. */
export function __clearWhatsAppSessionsForTests(): void {
  sessions.clear();
}

export interface SessionTransition {
  session: WhatsAppSession;
  reply: string;
}

function transition(session: WhatsAppSession, state: WhatsAppSessionState, reply: string): SessionTransition {
  session.state = state;
  return { session, reply };
}

const MAIN_MENU_TARGETS: WhatsAppMenuTarget[] = [
  "browse",
  "cart",
  "checkout_confirm",
  "track_order",
  "support",
];

/**
 * Advance the conversational state machine for one inbound text message.
 * Pure with respect to storage — the caller persists `session` afterwards.
 */
export function handleWhatsAppInboundText(
  session: WhatsAppSession,
  text: string,
): SessionTransition {
  const input = text.trim();

  // Menu keywords always bail out to the main menu.
  if (isMenuKeyword(input)) {
    return transition(session, "main_menu", renderMainMenu());
  }

  switch (session.state) {
    case "main_menu": {
      const n = resolveNumberedSelection(input, MAIN_MENU_TARGETS.length);
      if (n === null) {
        return transition(session, "main_menu", renderMainMenu());
      }
      const target = MAIN_MENU_TARGETS[n - 1];
      switch (target) {
        case "browse":
          return transition(session, "browse", renderBrowseMenu());
        case "cart":
          return transition(session, "cart", renderCart(session.cart));
        case "checkout_confirm":
          if (session.cart.length === 0) {
            return transition(
              session,
              "main_menu",
              "Your cart is empty — add something first.\n\n" + renderMainMenu(),
            );
          }
          return transition(
            session,
            "checkout_confirm",
            `${renderCart(session.cart)}\n\nReply 1 to confirm your order, or 0 to cancel.`,
          );
        case "track_order":
          return transition(
            session,
            "track_order",
            "Send your order reference and I will look up its status.",
          );
        case "support":
          return transition(
            session,
            "support",
            "You are through to support. Describe the issue and the team will follow up here.",
          );
      }
      break;
    }
    case "browse": {
      if (input === "0") {
        return transition(session, "main_menu", renderMainMenu());
      }
      const n = resolveNumberedSelection(input, STUB_CATALOG_ITEMS.length);
      if (n === null) {
        return transition(session, "browse", renderBrowseMenu());
      }
      const item = STUB_CATALOG_ITEMS[n - 1];
      session.cart.push(item.label);
      return transition(
        session,
        "cart",
        `Added ${item.label} to your cart.\n\n${renderCart(session.cart)}`,
      );
    }
    case "cart": {
      if (input === "0") {
        return transition(session, "main_menu", renderMainMenu());
      }
      if (input === "1" && session.cart.length > 0) {
        return transition(
          session,
          "checkout_confirm",
          `${renderCart(session.cart)}\n\nReply 1 to confirm your order, or 0 to cancel.`,
        );
      }
      return transition(session, "cart", renderCart(session.cart));
    }
    case "checkout_confirm": {
      if (input === "1") {
        // STUB: order placement integrates with the consumer checkout module
        // in a later wave; the skeleton only closes the flow out.
        session.cart = [];
        return transition(
          session,
          "main_menu",
          "Order confirmed! You will get tracking updates here.\n\n" + renderMainMenu(),
        );
      }
      return transition(session, "cart", renderCart(session.cart));
    }
    case "track_order": {
      const reference = input || "your order";
      session.data = { ...session.data, lastTrackingReference: reference };
      return transition(
        session,
        "main_menu",
        `Status for ${reference}: being prepared (demo).\n\n` + renderMainMenu(),
      );
    }
    case "support": {
      session.data = { ...session.data, lastSupportMessage: input };
      return transition(
        session,
        "main_menu",
        "Thanks — support has your message and will reply here.\n\n" + renderMainMenu(),
      );
    }
  }
  return transition(session, "main_menu", renderMainMenu());
}
