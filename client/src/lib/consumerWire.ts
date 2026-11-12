/**
 * Wire-shape normalizers, exact-money helpers and idempotency-key generation
 * for the PWA consumer marketplace (P2 consumer-parity wave; pages under
 * /shop and /account, procedures on consumer + consumerCatalog routers).
 *
 * Server money contract (P1): carts / checkout sessions carry bigint MINOR
 * units (kobo, NGN); provider_catalog_items.price and
 * membership_plans.monthly_price are TEXT/NUMERIC MAJOR units. All display
 * here is ₦ with exact 2-decimal integer/string math — never float.
 *
 * The tRPC payloads already arrive camelCase from server mappers; these
 * normalizers additionally tolerate snake_case keys and stringified bigint
 * columns, the same defensive approach as ./rentalConditionWire. Free of
 * trpc/react imports so the wire contract can be unit-tested in isolation.
 */

// ---------- idempotency keys ----------

/** Binding server contract: ^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$ */
export const CONSUMER_IDEMPOTENCY_KEY_RE =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

const IDEMPOTENCY_KEY_MAX = 128;

function randomUuid(): string {
  const cryptoApi =
    typeof globalThis !== "undefined"
      ? (globalThis as { crypto?: Crypto }).crypto
      : undefined;
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID();
  }
  // RFC4122 v4 fallback for environments without crypto.randomUUID
  // (older webviews / non-secure contexts). Not a secret — uniqueness only.
  const bytes = new Uint8Array(16);
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export type ConsumerIdempotencyScope =
  | "cart"
  | "checkout"
  | "subscribe"
  | "support";

/**
 * Build a regex-conformant idempotency key: scope prefix + optional
 * correlation segments (e.g. cart id + cart version) + a fresh UUID tail.
 * Disallowed characters are replaced with '-'; the key is capped at 128
 * chars with the UUID tail always preserved (uniqueness anchor).
 */
export function generateConsumerIdempotencyKey(
  scope: ConsumerIdempotencyScope,
  ...segments: Array<string | number | null | undefined>
): string {
  const uuid = randomUuid();
  const parts = [scope, ...segments, uuid]
    .filter(
      (part): part is string | number => part !== null && part !== undefined,
    )
    .map((part) => String(part).replace(/[^A-Za-z0-9._:-]+/g, "-"));
  let key = parts.join("-");
  if (key.length > IDEMPOTENCY_KEY_MAX) {
    const head = key.slice(0, IDEMPOTENCY_KEY_MAX - uuid.length - 1);
    key = `${head.replace(/[^A-Za-z0-9]+$/, "")}-${uuid}`;
  }
  if (!CONSUMER_IDEMPOTENCY_KEY_RE.test(key)) {
    // Unreachable given the construction; fail-closed rather than emitting a
    // key the server would reject as 22023.
    throw new Error("consumer_idempotency_key_generation_failed");
  }
  return key;
}

// ---------- exact money (minor units <-> ₦ display) ----------

function toMinorBigInt(minor: number | string | bigint): bigint {
  if (typeof minor === "bigint") return minor;
  if (typeof minor === "number") {
    if (!Number.isSafeInteger(minor)) {
      throw new Error("unsafe_minor_units_integer");
    }
    return BigInt(minor);
  }
  if (!/^-?\d+$/.test(minor.trim())) {
    throw new Error("invalid_minor_units_string");
  }
  return BigInt(minor.trim());
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Format integer minor units as ₦ with exactly 2 decimals, integer math
 * only: 660000 -> "₦6,600.00", 5 -> "₦0.05". Throws on unsafe/invalid input
 * rather than rendering a wrong amount.
 */
export function formatNairaMinor(minor: number | string | bigint): string {
  const value = toMinorBigInt(minor);
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 100n;
  const frac = String(absolute % 100n).padStart(2, "0");
  return `${sign}₦${groupThousands(whole.toString())}.${frac}`;
}

const MAJOR_RE = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parse a major-unit string ("6600", "6600.00", "6600.5") into integer
 * minor units using string math only. Throws on invalid input — callers
 * must not fall back to Number() parsing (float drift).
 */
export function majorToMinor(major: string): number {
  const match = MAJOR_RE.exec(major.trim());
  if (!match) {
    throw new Error(`invalid_major_units_string:${major}`);
  }
  const whole = BigInt(match[1]);
  const frac = BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  const minor = whole * 100n + frac;
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("major_units_exceed_safe_range");
  }
  return Number(minor);
}

/** Format a major-unit catalog/plan price string as ₦ with 2 decimals. */
export function formatNairaMajor(major: string): string {
  return formatNairaMinor(majorToMinor(major));
}

export type ConsumerFeeBreakdown = {
  subtotalMinor: number;
  platformFeeMinor: number;
  deliveryFeeMinor: number;
  totalMinor: number;
};

/** Platform fee: floor(subtotal * bps / 10000) — mirrors the server exactly. */
export function computePlatformFeeMinor(
  subtotalMinor: number | bigint,
  bps: number,
): number {
  return Number((BigInt(subtotalMinor) * BigInt(bps)) / 10000n);
}

/**
 * Pre-checkout fee projection. Caller passes the server-published fee config
 * (consumerCatalog.consumerFeeConfig) so the projection cannot drift from
 * the env-configured server values; when the config is unavailable the page
 * shows subtotal only and labels fees "calculated at checkout".
 */
export function computeFeeBreakdown(
  subtotalMinor: number | bigint,
  platformFeeBps: number,
  deliveryFeeMinor: number,
): ConsumerFeeBreakdown {
  const subtotal = Number(BigInt(subtotalMinor));
  const platformFeeMinor = computePlatformFeeMinor(subtotal, platformFeeBps);
  const totalMinor = subtotal + platformFeeMinor + deliveryFeeMinor;
  return { subtotalMinor: subtotal, platformFeeMinor, deliveryFeeMinor, totalMinor };
}

// ---------- shared normalization helpers ----------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pick<T>(
  record: Record<string, unknown>,
  ...keys: string[]
): T | undefined {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key] as T;
    }
  }
  return undefined;
}

/** bigint columns arrive as string|number; coerce defensively, never NaN. */
function toInt(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const d = new Date(value as string | Date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function listFrom(raw: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  const record = asRecord(raw);
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

// ---------- catalog shapes (consumerCatalog router) ----------

export interface ConsumerVertical {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
}

export function normalizeVertical(raw: unknown): ConsumerVertical | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = pick<unknown>(record, "id");
  if (id === undefined) return null;
  return {
    id: toInt(id),
    name: pick<string>(record, "name") ?? "",
    slug: pick<string>(record, "slug") ?? "",
    description: pick<string>(record, "description") ?? null,
    icon: pick<string>(record, "icon") ?? null,
  };
}

export function normalizeVerticals(raw: unknown): ConsumerVertical[] {
  const verticals: ConsumerVertical[] = [];
  for (const entry of listFrom(raw, "verticals", "items")) {
    const vertical = normalizeVertical(entry);
    if (vertical) verticals.push(vertical);
  }
  return verticals;
}

export interface ConsumerProvider {
  id: number;
  verticalId: number;
  name: string;
  businessName: string;
  address: string | null;
  /** Rating arrives as a varchar ("4.50"); kept as string, never float-parsed. */
  rating: string;
  status: string;
}

export function normalizeProvider(raw: unknown): ConsumerProvider | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = pick<unknown>(record, "id");
  if (id === undefined) return null;
  return {
    id: toInt(id),
    verticalId: toInt(pick<unknown>(record, "vertical_id", "verticalId")),
    name: pick<string>(record, "name") ?? "",
    businessName:
      pick<string>(record, "business_name", "businessName") ?? "",
    address: pick<string>(record, "address") ?? null,
    rating: String(pick<unknown>(record, "rating") ?? "0"),
    status: pick<string>(record, "status") ?? "",
  };
}

export function normalizeProviders(raw: unknown): ConsumerProvider[] {
  const providers: ConsumerProvider[] = [];
  for (const entry of listFrom(raw, "providers", "items")) {
    const provider = normalizeProvider(entry);
    if (provider) providers.push(provider);
  }
  return providers;
}

export interface ConsumerCatalogItem {
  id: number;
  providerId: number;
  sku: string;
  itemName: string;
  description: string | null;
  /** Major-unit price string exactly as stored ("1500.00"); never float. */
  priceMajor: string;
  currency: string;
}

export function normalizeCatalogItem(
  raw: unknown,
): ConsumerCatalogItem | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = pick<unknown>(record, "id");
  const priceMajor = pick<unknown>(record, "price_major", "priceMajor");
  if (id === undefined || priceMajor === undefined) return null;
  return {
    id: toInt(id),
    providerId: toInt(pick<unknown>(record, "provider_id", "providerId")),
    sku: pick<string>(record, "sku") ?? "",
    itemName: pick<string>(record, "item_name", "itemName") ?? "",
    description: pick<string>(record, "description") ?? null,
    priceMajor: String(priceMajor),
    currency: pick<string>(record, "currency") ?? "NGN",
  };
}

export function normalizeCatalogItems(raw: unknown): ConsumerCatalogItem[] {
  const items: ConsumerCatalogItem[] = [];
  for (const entry of listFrom(raw, "catalog", "items")) {
    const item = normalizeCatalogItem(entry);
    if (item) items.push(item);
  }
  return items;
}

export interface ConsumerMembershipPlan {
  id: number;
  planCode: string;
  planName: string;
  /** Major-unit monthly price string ("2500.00"); never float. */
  monthlyPriceMajor: string;
  deliveryFeeDiscountMajor: string;
  prioritySupport: boolean;
  cashbackRateMajor: string;
  perks: unknown[];
}

export function normalizeMembershipPlan(
  raw: unknown,
): ConsumerMembershipPlan | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = pick<unknown>(record, "id");
  if (id === undefined) return null;
  const perks = pick<unknown>(record, "perks");
  return {
    id: toInt(id),
    planCode: pick<string>(record, "plan_code", "planCode") ?? "",
    planName: pick<string>(record, "plan_name", "planName") ?? "",
    monthlyPriceMajor: String(
      pick<unknown>(record, "monthly_price_major", "monthlyPriceMajor") ?? "0",
    ),
    deliveryFeeDiscountMajor: String(
      pick<unknown>(
        record,
        "delivery_fee_discount_major",
        "deliveryFeeDiscountMajor",
      ) ?? "0",
    ),
    prioritySupport: Boolean(
      pick<unknown>(record, "priority_support", "prioritySupport"),
    ),
    cashbackRateMajor: String(
      pick<unknown>(record, "cashback_rate_major", "cashbackRateMajor") ?? "0",
    ),
    perks: Array.isArray(perks) ? perks : [],
  };
}

export function normalizeMembershipPlans(
  raw: unknown,
): ConsumerMembershipPlan[] {
  const plans: ConsumerMembershipPlan[] = [];
  for (const entry of listFrom(raw, "plans", "items")) {
    const plan = normalizeMembershipPlan(entry);
    if (plan) plans.push(plan);
  }
  return plans;
}

// ---------- cart / checkout shapes (consumer router) ----------

export interface ConsumerCartItemView {
  id: string;
  cartId: string;
  catalogItemId: number | null;
  name: string;
  /** Minor units; bigint-safe integer. */
  unitPriceMinor: number;
  quantity: number;
  modifiers: Array<Record<string, unknown>>;
}

export interface ConsumerCartView {
  id: string;
  status: string;
  serviceProviderId: number | null;
  verticalId: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ConsumerCartPayload {
  cart: ConsumerCartView;
  items: ConsumerCartItemView[];
}

export function normalizeCartItem(raw: unknown): ConsumerCartItemView | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = pick<string>(record, "id");
  if (!id) return null;
  const modifiers = pick<unknown>(record, "modifiers");
  return {
    id,
    cartId: pick<string>(record, "cart_id", "cartId") ?? "",
    catalogItemId:
      pick<unknown>(record, "catalog_item_id", "catalogItemId") === undefined
        ? null
        : toInt(pick<unknown>(record, "catalog_item_id", "catalogItemId")),
    name: pick<string>(record, "name") ?? "",
    unitPriceMinor: toInt(pick<unknown>(record, "unit_price_minor", "unitPriceMinor")),
    quantity: toInt(pick<unknown>(record, "quantity"), 1),
    modifiers: Array.isArray(modifiers)
      ? modifiers.filter(
          (entry): entry is Record<string, unknown> => asRecord(entry) !== null,
        )
      : [],
  };
}

/** Accepts {cart, items} (consumer.myCart shape) or null. */
export function normalizeCartPayload(raw: unknown): ConsumerCartPayload | null {
  const record = asRecord(raw);
  if (!record) return null;
  const cartRecord = asRecord(record.cart);
  if (!cartRecord) return null;
  const id = pick<string>(cartRecord, "id");
  if (!id) return null;
  const items = Array.isArray(record.items) ? record.items : [];
  return {
    cart: {
      id,
      status: pick<string>(cartRecord, "status") ?? "active",
      serviceProviderId:
        pick<unknown>(cartRecord, "service_provider_id", "serviceProviderId") ===
        undefined
          ? null
          : toInt(
              pick<unknown>(cartRecord, "service_provider_id", "serviceProviderId"),
            ),
      verticalId:
        pick<unknown>(cartRecord, "vertical_id", "verticalId") === undefined
          ? null
          : toInt(pick<unknown>(cartRecord, "vertical_id", "verticalId")),
      createdAt:
        toIso(pick<unknown>(cartRecord, "created_at", "createdAt")) ?? null,
      updatedAt:
        toIso(pick<unknown>(cartRecord, "updated_at", "updatedAt")) ?? null,
    },
    items: items
      .map(normalizeCartItem)
      .filter((item): item is ConsumerCartItemView => item !== null),
  };
}

/** Exact subtotal of the cart lines in minor units (bigint math). */
export function cartSubtotalMinor(items: ConsumerCartItemView[]): number {
  let total = 0n;
  for (const item of items) {
    total += BigInt(item.unitPriceMinor) * BigInt(item.quantity);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("cart_subtotal_exceeds_safe_range");
  }
  return Number(total);
}

export function cartItemCount(items: ConsumerCartItemView[]): number {
  return items.reduce((count, item) => count + item.quantity, 0);
}

/** A cart "version" for per-version checkout idempotency keys. */
export function cartVersion(cart: ConsumerCartView): string {
  return cart.updatedAt ?? cart.createdAt ?? cart.id;
}

export type ConsumerCheckoutStatus =
  | "open"
  | "payment_pending"
  | "paid"
  | "failed"
  | "expired";

export const TERMINAL_CHECKOUT_STATUSES: ConsumerCheckoutStatus[] = [
  "paid",
  "failed",
  "expired",
];

export function isTerminalCheckoutStatus(status: string): boolean {
  return TERMINAL_CHECKOUT_STATUSES.includes(status as ConsumerCheckoutStatus);
}

export interface ConsumerCheckoutView {
  orderId: number;
  orderNumber: string;
  checkoutSessionId: string;
  status: string;
  subtotalMinor: number;
  platformFeeMinor: number;
  deliveryFeeMinor: number;
  totalMinor: number;
  currency: string;
  expiresAt: string | null;
  paymentReference: string | null;
  replayed: boolean;
}

export function normalizeCheckoutResult(
  raw: unknown,
): ConsumerCheckoutView | null {
  const record = asRecord(raw);
  if (!record) return null;
  const sessionId = pick<string>(
    record,
    "checkout_session_id",
    "checkoutSessionId",
  );
  if (!sessionId) return null;
  return {
    orderId: toInt(pick<unknown>(record, "order_id", "orderId")),
    orderNumber: pick<string>(record, "order_number", "orderNumber") ?? "",
    checkoutSessionId: sessionId,
    status: pick<string>(record, "status") ?? "open",
    subtotalMinor: toInt(pick<unknown>(record, "subtotal_minor", "subtotalMinor")),
    platformFeeMinor: toInt(
      pick<unknown>(record, "platform_fee_minor", "platformFeeMinor"),
    ),
    deliveryFeeMinor: toInt(
      pick<unknown>(record, "delivery_fee_minor", "deliveryFeeMinor"),
    ),
    totalMinor: toInt(pick<unknown>(record, "total_minor", "totalMinor")),
    currency: pick<string>(record, "currency") ?? "NGN",
    expiresAt: toIso(pick<unknown>(record, "expires_at", "expiresAt")),
    paymentReference:
      pick<string>(record, "payment_reference", "paymentReference") ?? null,
    replayed: Boolean(pick<unknown>(record, "replayed")),
  };
}

// ---------- group orders ----------

export interface ConsumerGroupOrderView {
  id: string;
  status: string;
  shareCode: string;
  maxParticipants: number;
  participantCount: number;
  alreadyJoined: boolean;
}

export function normalizeGroupOrder(
  raw: unknown,
): ConsumerGroupOrderView | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = pick<string>(record, "id");
  if (!id) return null;
  return {
    id,
    status: pick<string>(record, "status") ?? "open",
    shareCode: pick<string>(record, "share_code", "shareCode") ?? "",
    maxParticipants: toInt(
      pick<unknown>(record, "max_participants", "maxParticipants"),
      8,
    ),
    participantCount: toInt(
      pick<unknown>(record, "participant_count", "participantCount"),
    ),
    alreadyJoined: Boolean(
      pick<unknown>(record, "already_joined", "alreadyJoined"),
    ),
  };
}

// ---------- subscriptions ----------

export interface ConsumerSubscriptionView {
  id: string;
  planId: number;
  status: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
}

export function normalizeSubscription(
  raw: unknown,
): ConsumerSubscriptionView | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = pick<string>(record, "id");
  if (!id) return null;
  return {
    id,
    planId: toInt(pick<unknown>(record, "plan_id", "planId")),
    status: pick<string>(record, "status") ?? "active",
    currentPeriodStart: toIso(
      pick<unknown>(record, "current_period_start", "currentPeriodStart"),
    ),
    currentPeriodEnd: toIso(
      pick<unknown>(record, "current_period_end", "currentPeriodEnd"),
    ),
  };
}

// ---------- order tracking events (order_tracking_events, read-only) ----------

export interface ConsumerTrackingEvent {
  id: number;
  eventType: string;
  statusLabel: string;
  etaMinutes: number | null;
  eventTime: string | null;
}

export function normalizeTrackingEvent(
  raw: unknown,
): ConsumerTrackingEvent | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = pick<unknown>(record, "id");
  if (id === undefined) return null;
  const eta = pick<unknown>(record, "eta_minutes", "etaMinutes");
  return {
    id: toInt(id),
    eventType: pick<string>(record, "event_type", "eventType") ?? "",
    statusLabel: pick<string>(record, "status_label", "statusLabel") ?? "",
    etaMinutes: eta === undefined ? null : toInt(eta),
    eventTime: toIso(pick<unknown>(record, "event_time", "eventTime")),
  };
}

export function normalizeTrackingEvents(raw: unknown): ConsumerTrackingEvent[] {
  const events: ConsumerTrackingEvent[] = [];
  for (const entry of listFrom(raw, "events", "items")) {
    const event = normalizeTrackingEvent(entry);
    if (event) events.push(event);
  }
  return events;
}

// ---------- checkout key cache (per cart version) ----------

/**
 * Checkout idempotency keys are generated per cart VERSION (cart.updatedAt)
 * and cached so a retry after payment_initiation_failed — or a remount of
 * the checkout page — reuses the SAME key and the server replays the stored
 * session instead of double-charging. A cart edit (new updatedAt) rotates
 * the key. sessionStorage is used when available so a page reload keeps the
 * key; a module-level Map is the no-storage fallback.
 */
const memoryCheckoutKeys = new Map<string, string>();

export function getOrCreateCheckoutKey(
  cartId: string,
  version: string,
  storage?: Pick<Storage, "getItem" | "setItem"> | null,
): string {
  const storageKey = `consumer.checkoutKey.${cartId}`;
  const expectedPrefix = `checkout-${cartId}-`;
  const store =
    storage ??
    (typeof window !== "undefined" ? safeSessionStorage() : null);
  if (store) {
    try {
      const cached = store.getItem(storageKey);
      if (cached) {
        const parsed = JSON.parse(cached) as { version?: string; key?: string };
        if (
          parsed.version === version &&
          typeof parsed.key === "string" &&
          parsed.key.startsWith(expectedPrefix) &&
          CONSUMER_IDEMPOTENCY_KEY_RE.test(parsed.key)
        ) {
          return parsed.key;
        }
      }
    } catch {
      // fall through to regenerate
    }
  } else {
    const cached = memoryCheckoutKeys.get(storageKey);
    if (cached) {
      const sep = cached.indexOf("|");
      const cachedVersion = cached.slice(0, sep);
      const key = cached.slice(sep + 1);
      if (cachedVersion === version && CONSUMER_IDEMPOTENCY_KEY_RE.test(key)) {
        return key;
      }
    }
  }
  const key = generateConsumerIdempotencyKey("checkout", cartId, version);
  if (store) {
    try {
      store.setItem(storageKey, JSON.stringify({ version, key }));
    } catch {
      memoryCheckoutKeys.set(storageKey, `${version}|${key}`);
    }
  } else {
    memoryCheckoutKeys.set(storageKey, `${version}|${key}`);
  }
  return key;
}

function safeSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
