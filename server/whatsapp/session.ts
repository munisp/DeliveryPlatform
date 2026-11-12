import type {
  ConsumerCatalogItem,
  ConsumerProvider,
  ConsumerVertical,
} from "../_core/consumerCatalog";
import type { ConsumerOrderSummary } from "../_core/consumerQueries";
import { runWhatsAppFlow } from "./flows";

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
 * LIMITATION (kept from P1, re-verified on main for P2): session persistence
 * is an in-process Map with TTL — there is no suitable existing Postgres
 * table in this schema for conversational sessions
 * (consumer_processed_events is an idempotency ledger, not session state),
 * and this program forbids schema changes from this module. Sessions
 * therefore do NOT survive a pod restart or scale-out: each replica holds
 * its own copy and a customer pinned to another replica starts over at the
 * main menu. The temporary "link <accountId>" binding lives on the session
 * and is lost with it (documented in identity.ts / flows.ts).
 *
 * P2: the handler is now async (browse/track/support/checkout hit the real
 * consumer commerce layer via flows.ts) and the cart holds MINOR-unit price
 * snapshots instead of stub labels.
 */

export type WhatsAppSessionState =
  | "main_menu"
  | "browse"
  | "cart"
  | "checkout_confirm"
  | "track_order"
  | "support";

/** One cart line. unitPriceMinor is MINOR units (kobo) — integer only. */
export interface WhatsAppCartLine {
  catalogItemId: number | null;
  name: string;
  unitPriceMinor: number;
  quantity: number;
}

export interface WhatsAppSessionData {
  /** browse flow */
  browseStage?: "verticals" | "providers" | "items";
  verticals?: ConsumerVertical[];
  providers?: ConsumerProvider[];
  items?: ConsumerCatalogItem[];
  verticalId?: number;
  verticalName?: string;
  providerId?: number;
  providerName?: string;
  page?: number;
  /** checkout flow */
  cartVersion?: number;
  checkoutStage?: "address" | "confirm";
  deliveryAddress?: string;
  deliveryLat?: number | null;
  deliveryLng?: number | null;
  /** track flow */
  orders?: ConsumerOrderSummary[];
  /** support flow: per-session case counter for idempotency keys */
  supportSeq?: number;
}

export interface WhatsAppSession {
  phone: string;
  state: WhatsAppSessionState;
  /** Cart lines with MINOR-unit price snapshots from the catalog. */
  cart: WhatsAppCartLine[];
  /** Resolved public.users.id once linked (phone match or "link <id>"). */
  linkedUserId: number | null;
  /** Free-form flow data (browse pages, checkout details, ...). */
  data?: WhatsAppSessionData;
  updatedAt: number;
}

/** Sessions idle longer than this are pruned on next access. */
export const WA_SESSION_TTL_MS = 30 * 60 * 1000;

const sessions = new Map<string, WhatsAppSession>();

export function newWhatsAppSession(phone: string): WhatsAppSession {
  return {
    phone,
    state: "main_menu",
    cart: [],
    linkedUserId: null,
    updatedAt: Date.now(),
  };
}

export async function getWhatsAppSession(
  phone: string,
): Promise<WhatsAppSession | null> {
  const session = sessions.get(phone);
  if (!session) return null;
  if (session.updatedAt + WA_SESSION_TTL_MS <= Date.now()) {
    sessions.delete(phone);
    return null;
  }
  return session;
}

export async function saveWhatsAppSession(
  session: WhatsAppSession,
): Promise<void> {
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

/** Extra context for one inbound message (reserved for idempotency keys). */
export interface WhatsAppInboundContext {
  messageId?: string;
}

/**
 * Advance the conversational state machine for one inbound text message.
 * Async since P2 (real catalog/checkout/order reads). Pure with respect to
 * storage — the caller persists `session` afterwards.
 */
export async function handleWhatsAppInboundText(
  session: WhatsAppSession,
  text: string,
  ctx?: WhatsAppInboundContext,
): Promise<SessionTransition> {
  return runWhatsAppFlow(session, text, ctx ?? {});
}
