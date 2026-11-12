import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { getPool } from "../db";
import { minorToMajorString } from "./consumerCommerce";
import { ENV } from "./env";
import { createMerchantProduct } from "./merchantCommerce";
import { resilientFetch } from "./resilientFetch";

/**
 * Merchant self-serve (WS-MERCHANT, P3-M) — the merchant-portal gaps vs
 * Glovo/DoorDash:
 *
 *  1. merchantSignup — the ONE greenfield intake that creates the
 *     public.service_providers row (status/verification 'pending') and opens
 *     the commerce merchant portal via commerce.begin_merchant_onboarding
 *     (0064:114) in the SAME transaction. Idempotent PER ACTOR: replay (same
 *     ledger key, or any later call once the actor owns a portal) returns the
 *     existing provider+portal without inserting again.
 *  2. Catalog projection — mirrors commerce.merchant_catalog_product mappings
 *     (written by merchantCommerce.createMerchantProduct, which keeps Medusa
 *     as source of truth) into public.provider_catalog_items so products
 *     become consumer-visible through consumerCatalog.listConsumerCatalog
 *     (/shop). Upsert rides the real UNIQUE(provider_id, sku) constraint
 *     (drizzle/0003:177). sku = Medusa product id; price is the legacy TEXT
 *     major-unit convention derived from Medusa's integer minor amount via
 *     exact integer string math (minorToMajorString, P1 contract).
 *  3. myFulfillmentRequests — merchant-scoped read over
 *     commerce.fulfillment_request. The operator-only SQL list fn
 *     (commerce.list_fulfillment_requests, 0046:168, hard is_platform_operator)
 *     is deliberately NOT reused; the query here pins provider_id to the
 *     caller's authorized portal.
 *  4. transitionMyFulfillment — merchant-legal edges of the 0046 state
 *     machine. commerce.transition_fulfillment (0046:121) cannot be wrapped:
 *     it is hard operator-only (is_platform_operator else 42501), so the
 *     merchant path re-implements the same row-lock + idempotent-event +
 *     timestamp-CHECK discipline in a transaction, restricted to:
 *       accept : requested -> accepted      (sets accepted_at)
 *       reject : requested -> cancelled     (sets cancelled_at; reason in event detail)
 *       ready  : accepted   -> accepted     (DEVIATION, documented: the 0046
 *         fulfillment_state enum has NO ready-for-pickup state; 'ready' is
 *         recorded as an append-only commerce.fulfillment.ready evidence event
 *         WITHOUT a state change. assign/dispatch stay operator-only.)
 *  5. myEarnings — read-only aggregates. orders gross uses the legacy varchar
 *     MAJOR-unit convention (0104 writes '6600.00' style strings) summed via
 *     ::numeric cast — documented; a malformed legacy row would raise 22P02
 *     and surface as an error, never a fabricated zero. Payout visibility is
 *     a boolean (merchant_payment_configuration.enabled) — the payout
 *     reference itself is a sha256 digest and is NEVER returned.
 *  6. updateStorefrontProfile — owner-only UPDATE of service_providers display
 *     columns (name/address/latitude/longitude). status, verification_status,
 *     rating and commission_rate are operator/platform-owned and are never
 *     written here. Store hours are DEFERRED: service_providers has no hours
 *     column (P3_RECON §WS-MERCHANT) — follow-up, no DDL this wave.
 *
 * Authz: every provider-scoped procedure goes through
 * commerce.authorize_merchant_portal (0064:165) with the closest role set
 * (documented per procedure). PostgreSQL errcodes are mapped per the program
 * contract: 22023→BAD_REQUEST, P0002→NOT_FOUND, 42501→FORBIDDEN,
 * 23505/23514/55000→CONFLICT (consumerCommerce.mapConsumerCheckoutError
 * convention).
 *
 * Idempotency ledger: public.consumer_processed_events (0072) with
 * consumer_name 'merchant-selfserve'; event_id is `${actorUserId}:${key}` so
 * keys are actor-scoped and can never collide across merchants.
 */

export const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

const idempotencyKeySchema = z.string().regex(IDEMPOTENCY_KEY_REGEX);
const providerIdSchema = z.number().int().positive();

const LEDGER_CONSUMER = "merchant-selfserve";
const SIGNUP_TOPIC = "signup";
const STOREFRONT_TOPIC = "storefront-update";

/**
 * Role sets for commerce.authorize_merchant_portal. The 0064 role enum is
 * owner|catalog_manager|inventory_manager|finance_viewer; there is no
 * dedicated fulfillment role (the fulfillment:read credential scope
 * anticipates API clients, not portal members). Closest mapping, documented:
 * fulfillment read/write → owner + inventory_manager (stock/dispatch side);
 * catalog projection → owner + catalog_manager; earnings → owner +
 * finance_viewer; storefront profile → owner only.
 */
const FULFILLMENT_ROLES = ["owner", "inventory_manager"] as const;
const CATALOG_ROLES = ["owner", "catalog_manager"] as const;
const FINANCE_ROLES = ["owner", "finance_viewer"] as const;
const OWNER_ROLES = ["owner"] as const;

// ---------------------------------------------------------------------------
// Input schemas (exported so the router stays a thin binding; P1 pattern)
// ---------------------------------------------------------------------------

export const merchantSignupInputSchema = z.object({
  legalName: z.string().trim().min(2).max(255),
  displayName: z.string().trim().min(2).max(160),
  address: z.string().trim().min(3).max(1000),
  latitude: z.number().gte(-90).lte(90).optional(),
  longitude: z.number().gte(-180).lte(180).optional(),
  verticalId: z.number().int().positive().optional(),
  contactEmail: z.string().trim().email().max(320).optional(),
  contactPhone: z.string().trim().min(5).max(20).optional(),
  medusaStoreId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/)
    .optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const publishCatalogProjectionInputSchema = z.object({
  providerId: providerIdSchema,
  /** When set, only this mapped Medusa product is (re-)projected. */
  medusaProductId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/)
    .optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
});

export const syncCatalogInputSchema = z.object({
  providerId: providerIdSchema,
});

export const myFulfillmentRequestsInputSchema = z.object({
  providerId: providerIdSchema,
  status: z
    .enum([
      "requested",
      "accepted",
      "assigned",
      "out_for_delivery",
      "delivered",
      "cancelled",
      "failed",
    ])
    .optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export const transitionMyFulfillmentInputSchema = z.object({
  fulfillmentId: z.string().uuid(),
  action: z.enum(["accept", "reject", "ready"]),
  reason: z.string().trim().min(3).max(1000).optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const myEarningsInputSchema = z.object({
  providerId: providerIdSchema,
});

export const updateStorefrontProfileInputSchema = z.object({
  providerId: providerIdSchema,
  displayName: z.string().trim().min(2).max(255).optional(),
  address: z.string().trim().min(3).max(1000).optional(),
  latitude: z.number().gte(-90).lte(90).optional(),
  longitude: z.number().gte(-180).lte(180).optional(),
  idempotencyKey: idempotencyKeySchema,
});

// ---------------------------------------------------------------------------
// Error mapping (P1/P2 contract)
// ---------------------------------------------------------------------------

export function mapMerchantSqlError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  const pgCode = (error as { code?: string })?.code;
  const message = (error as Error)?.message ?? "merchant_selfserve_failed";
  switch (pgCode) {
    case "22023":
      throw new TRPCError({ code: "BAD_REQUEST", message, cause: error });
    case "P0002":
      throw new TRPCError({ code: "NOT_FOUND", message, cause: error });
    case "42501":
      throw new TRPCError({ code: "FORBIDDEN", message, cause: error });
    case "23505":
    case "23514":
    case "55000":
      throw new TRPCError({ code: "CONFLICT", message, cause: error });
    default:
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "merchant_selfserve_failed",
        cause: error,
      });
  }
}

type Queryable = {
  query: <T = unknown>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

type PortalContext = {
  provider_id: number;
  medusa_store_id: string;
  default_stock_location_id: string | null;
  payment_enabled: boolean;
  settlement_fsp_alias: string | null;
  currency_code: string | null;
};

/** commerce.authorize_merchant_portal wrapper (0064:165). */
async function authorizeMerchantPortal(
  db: Queryable,
  actorUserId: number,
  providerId: number,
  roles: readonly string[],
): Promise<PortalContext> {
  const result = await db.query<PortalContext>(
    `SELECT * FROM commerce.authorize_merchant_portal(
       $1,$2,$3::commerce.merchant_access_role[]
     )`,
    [actorUserId, providerId, roles as unknown as string[]],
  );
  if (result.rows.length !== 1) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "merchant_portal_authorization_failed",
    });
  }
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// 1. merchantSignup
// ---------------------------------------------------------------------------

export type MerchantSignupResult = {
  providerId: number;
  onboardingState: string;
  medusaStoreId: string;
  /** true when the call replayed a previously recorded result. */
  replayed: boolean;
  /** true when the actor already owned a portal before this call. */
  existingPortal: boolean;
};

/**
 * Greenfield merchant intake: INSERT public.service_providers (status
 * 'pending', verification_status 'pending' — exact column set per
 * drizzle/schema.ts:144-162; vertical_id/name/business_name/email/phone are
 * NOT NULL there, so contact email/phone fall back to the caller's
 * public.users row) + commerce.begin_merchant_onboarding in one transaction.
 *
 * Replay design (PER ACTOR, two layers):
 *  - exact replay: consumer_processed_events ledger hit on
 *    ('merchant-selfserve','signup', `${actor}:${key}`) returns the stored
 *    result untouched;
 *  - per-actor replay: if the actor already owns a portal row (owner_user_id
 *    or an active owner-role access grant), the existing provider+portal is
 *    returned WITHOUT inserting a second service_providers row — one merchant
 *    per actor this wave.
 */
export async function merchantSignup(input: {
  actorUserId: number;
  legalName: string;
  displayName: string;
  address: string;
  latitude?: number;
  longitude?: number;
  verticalId?: number;
  contactEmail?: string;
  contactPhone?: string;
  medusaStoreId?: string;
  idempotencyKey: string;
}): Promise<MerchantSignupResult> {
  const pool = await getPool();
  const ledgerId = `${input.actorUserId}:${input.idempotencyKey}`;

  const stored = await pool.query<{ result_json: unknown }>(
    `SELECT result_json FROM public.consumer_processed_events
     WHERE consumer_name = $1 AND topic = $2 AND event_id = $3`,
    [LEDGER_CONSUMER, SIGNUP_TOPIC, ledgerId],
  );
  const storedResult = stored.rows[0]?.result_json as
    | { provider_id?: number; onboarding_state?: string; medusa_store_id?: string }
    | undefined;
  if (storedResult && typeof storedResult.provider_id === "number") {
    return {
      providerId: storedResult.provider_id,
      onboardingState: String(storedResult.onboarding_state ?? "unknown"),
      medusaStoreId: String(storedResult.medusa_store_id ?? ""),
      replayed: true,
      existingPortal: false,
    };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize concurrent signups by the same actor (0046 advisory-lock pattern).
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('merchant-signup:' || $1::text, 0))`,
      [input.actorUserId],
    );

    // Per-actor replay: existing portal ownership short-circuits the insert.
    const existing = await client.query<{ provider_id: number; state: string; medusa_store_id: string }>(
      `SELECT p.provider_id, p.state::text AS state, p.medusa_store_id
       FROM commerce.merchant_portal p
       WHERE p.owner_user_id = $1
          OR EXISTS (
            SELECT 1 FROM commerce.merchant_user_access a
            WHERE a.provider_id = p.provider_id AND a.user_id = $1
              AND a.active AND a.role = 'owner'::commerce.merchant_access_role
          )
       ORDER BY p.provider_id
       LIMIT 1`,
      [input.actorUserId],
    );
    if (existing.rows[0]) {
      const result: MerchantSignupResult = {
        providerId: Number(existing.rows[0].provider_id),
        onboardingState: String(existing.rows[0].state),
        medusaStoreId: String(existing.rows[0].medusa_store_id),
        replayed: true,
        existingPortal: true,
      };
      await recordLedger(client, SIGNUP_TOPIC, ledgerId, {
        provider_id: result.providerId,
        onboarding_state: result.onboardingState,
        medusa_store_id: result.medusaStoreId,
      });
      await client.query("COMMIT");
      return result;
    }

    // Vertical: explicit id must exist and be active; otherwise fall back to
    // the lowest active vertical (seed: id 1 'food-delivery'). Fail closed.
    const vertical = await client.query<{ id: number }>(
      `SELECT id FROM public.service_verticals
       WHERE is_active AND ($1::integer IS NULL OR id = $1)
       ORDER BY id
       LIMIT 1`,
      [input.verticalId ?? null],
    );
    const verticalId = vertical.rows[0]?.id;
    if (!verticalId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: input.verticalId
          ? "vertical_not_available"
          : "vertical_required",
      });
    }

    // Contact fallback: service_providers.email/phone are NOT NULL; use the
    // caller's public.users row when not supplied explicitly.
    const contact = await client.query<{ email: string | null; phone: string | null }>(
      `SELECT email, phone FROM public.users WHERE id = $1`,
      [input.actorUserId],
    );
    const email = input.contactEmail ?? contact.rows[0]?.email ?? null;
    const phone = input.contactPhone ?? contact.rows[0]?.phone ?? null;
    if (!email) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "contact_email_required" });
    }
    if (!phone) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "contact_phone_required" });
    }

    const inserted = await client.query<{ id: number }>(
      `INSERT INTO public.service_providers (
         vertical_id, name, business_name, email, phone,
         address, latitude, longitude,
         status, verification_status, category
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending','pending','general')
       RETURNING id`,
      [
        verticalId,
        input.displayName.trim(),
        input.legalName.trim(),
        email,
        phone,
        input.address.trim(),
        input.latitude === undefined ? null : String(input.latitude),
        input.longitude === undefined ? null : String(input.longitude),
      ],
    );
    const providerId = Number(inserted.rows[0].id);

    // The portal DDL requires a Medusa store id at onboarding time; merchants
    // who do not have one yet get a deterministic placeholder they can replace
    // by re-running beginOnboarding from the portal (0064 upsert while
    // verification_pending).
    const medusaStoreId = input.medusaStoreId ?? `dp-store-${providerId}`;

    const onboarding = await client.query<{ state: string }>(
      `SELECT commerce.begin_merchant_onboarding($1,$2,$3,$4,$5,$6) AS state`,
      [
        input.actorUserId,
        providerId,
        input.legalName.trim(),
        input.displayName.trim(),
        medusaStoreId,
        input.idempotencyKey,
      ],
    );
    const onboardingState = String(onboarding.rows[0]?.state ?? "unknown");

    await recordLedger(client, SIGNUP_TOPIC, ledgerId, {
      provider_id: providerId,
      onboarding_state: onboardingState,
      medusa_store_id: medusaStoreId,
    });
    await client.query("COMMIT");
    return {
      providerId,
      onboardingState,
      medusaStoreId,
      replayed: false,
      existingPortal: false,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    mapMerchantSqlError(error);
  } finally {
    client.release();
  }
}

async function recordLedger(
  db: Queryable,
  topic: string,
  eventId: string,
  result: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO public.consumer_processed_events (consumer_name, topic, event_id, result_json)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (consumer_name, topic, event_id) DO NOTHING`,
    [LEDGER_CONSUMER, topic, eventId, JSON.stringify(result)],
  );
}

// ---------------------------------------------------------------------------
// 2. Catalog projection (Medusa → public.provider_catalog_items)
// ---------------------------------------------------------------------------

type MedusaAdminProduct = {
  id?: string;
  handle?: string;
  title?: string;
  description?: string | null;
  status?: string;
  variants?: Array<{
    prices?: Array<{ currency_code?: string; amount?: number }>;
  }>;
};

/**
 * Minimal Medusa admin read client. merchantCommerce.ts keeps its client
 * private (and is outside P3-M's owned paths), so the fail-closed gateway
 * pattern (merchantCommerce.ts:58-90) is mirrored here — read-only.
 */
async function medusaGetProduct(productId: string): Promise<MedusaAdminProduct> {
  if (!ENV.medusaMerchantApiUrl || !ENV.medusaMerchantApiToken) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "medusa_merchant_gateway_unconfigured",
    });
  }
  const response = await resilientFetch(
    `${ENV.medusaMerchantApiUrl}/admin/products/${encodeURIComponent(productId)}`,
    {
      headers: {
        Authorization: `Basic ${ENV.medusaMerchantApiToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `medusa_merchant_gateway_${response.status}`,
    });
  }
  let parsed: { product?: MedusaAdminProduct };
  try {
    parsed = JSON.parse(body) as { product?: MedusaAdminProduct };
  } catch {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "medusa_merchant_gateway_invalid_json",
    });
  }
  if (!parsed.product?.id) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "medusa_product_read_response_invalid",
    });
  }
  return parsed.product;
}

export type CatalogProjectionItemResult = {
  medusaProductId: string;
  sku: string;
  itemName: string;
  price: string;
  currency: string;
  isAvailable: boolean;
};

export type CatalogProjectionResult = {
  providerId: number;
  projected: number;
  /** Mapped products with no Medusa price variant — left untouched. */
  skipped: number;
  /** Medusa read failures (per-product fail-open; syncCatalog is the repair). */
  failed: string[];
  items: CatalogProjectionItemResult[];
};

/**
 * Mirror commerce.merchant_catalog_product mappings into
 * public.provider_catalog_items. Constraint reality: provider_catalog_items
 * has a real UNIQUE(provider_id, sku) (drizzle/0003:177), so the upsert is a
 * plain INSERT ... ON CONFLICT (provider_id, sku) DO UPDATE — no
 * SELECT-then-write race. sku = Medusa product id (stable, one row per
 * product per provider). Medusa remains the source of truth for
 * title/description/price/status; commerce.merchant_catalog_product holds
 * only ids/handle/state, hence the Medusa read per product.
 */
export async function projectProviderCatalog(input: {
  actorUserId: number;
  providerId: number;
  medusaProductId?: string;
}): Promise<CatalogProjectionResult> {
  const pool = await getPool();
  const context = await authorizeMerchantPortal(
    pool,
    input.actorUserId,
    input.providerId,
    CATALOG_ROLES,
  ).catch(mapMerchantSqlError);

  const mappings = await pool.query<{
    medusa_product_id: string;
    product_handle: string;
    state: string;
  }>(
    `SELECT medusa_product_id, product_handle, state
     FROM commerce.merchant_catalog_product
     WHERE provider_id = $1
       AND ($2::text IS NULL OR medusa_product_id = $2)
     ORDER BY medusa_product_id`,
    [input.providerId, input.medusaProductId ?? null],
  );
  if (input.medusaProductId && mappings.rows.length === 0) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "merchant_catalog_product_not_found",
    });
  }

  const result: CatalogProjectionResult = {
    providerId: input.providerId,
    projected: 0,
    skipped: 0,
    failed: [],
    items: [],
  };

  for (const mapping of mappings.rows) {
    let product: MedusaAdminProduct;
    try {
      product = await medusaGetProduct(mapping.medusa_product_id);
    } catch (error) {
      if (
        error instanceof TRPCError &&
        error.code === "PRECONDITION_FAILED"
      ) {
        throw error; // gateway unconfigured is a hard stop, not per-product
      }
      result.failed.push(mapping.medusa_product_id);
      continue;
    }

    // Price: Medusa stores integer MINOR units per currency. Prefer the
    // portal's configured settlement currency, else the first variant price.
    const prices = (product.variants ?? []).flatMap((v) => v.prices ?? []);
    const portalCurrency = context.currency_code?.toLowerCase();
    const price =
      (portalCurrency
        ? prices.find((p) => p.currency_code?.toLowerCase() === portalCurrency)
        : undefined) ?? prices[0];
    if (!price || typeof price.amount !== "number" || !Number.isInteger(price.amount)) {
      result.skipped += 1;
      continue;
    }
    const currency = (price.currency_code ?? context.currency_code ?? "NGN").toUpperCase();
    const priceMajor = minorToMajorString(price.amount);
    const isAvailable = product.status === "published";
    const itemName = (product.title ?? "").trim().slice(0, 255);
    if (itemName.length < 1) {
      result.skipped += 1;
      continue;
    }

    await pool.query(
      `INSERT INTO public.provider_catalog_items (
         provider_id, sku, item_name, description, price, currency, is_available, metadata
       ) VALUES ($1,$2,$3,$4,$5::numeric,$6,$7,$8::jsonb)
       ON CONFLICT (provider_id, sku) DO UPDATE SET
         item_name = EXCLUDED.item_name,
         description = EXCLUDED.description,
         price = EXCLUDED.price,
         currency = EXCLUDED.currency,
         is_available = EXCLUDED.is_available,
         metadata = EXCLUDED.metadata,
         updated_at = now()`,
      [
        input.providerId,
        mapping.medusa_product_id,
        itemName,
        product.description ?? null,
        priceMajor,
        currency,
        isAvailable,
        JSON.stringify({
          medusa_product_id: mapping.medusa_product_id,
          product_handle: product.handle ?? mapping.product_handle,
          medusa_status: product.status ?? null,
        }),
      ],
    );
    result.projected += 1;
    result.items.push({
      medusaProductId: mapping.medusa_product_id,
      sku: mapping.medusa_product_id,
      itemName,
      price: priceMajor,
      currency,
      isAvailable,
    });
  }
  return result;
}

/**
 * Repair path: re-project every mapped product for the provider (same engine
 * as publishCatalogProjection with no product filter).
 */
export async function syncProviderCatalog(input: {
  actorUserId: number;
  providerId: number;
}): Promise<CatalogProjectionResult> {
  return projectProviderCatalog(input);
}

/**
 * Wrapped createProduct path: creates the product in Medusa + records the
 * commerce mapping via the existing merchantCommerce module, then projects
 * the new product into provider_catalog_items in the same call. Projection is
 * best-effort AFTER the product exists: a projection failure is reported in
 * the result (`projectionError`) instead of failing the mutation, because the
 * Medusa product + mapping are already durable — syncCatalog is the repair
 * path.
 */
export async function createMerchantProductWithProjection(input: {
  actorUserId: number;
  providerId: number;
  title: string;
  handle: string;
  description: string;
  status: "draft" | "published";
  currencyCode: string;
  priceMinor: number;
  sku: string;
  imageUrls: string[];
  idempotencyKey: string;
}) {
  const created = await createMerchantProduct(input);
  try {
    const projection = await projectProviderCatalog({
      actorUserId: input.actorUserId,
      providerId: input.providerId,
      medusaProductId: created.productId,
    });
    return { ...created, projection, projectionError: null as string | null };
  } catch (error) {
    return {
      ...created,
      projection: null,
      projectionError:
        error instanceof TRPCError ? error.message : "catalog_projection_failed",
    };
  }
}

// ---------------------------------------------------------------------------
// 3. myFulfillmentRequests (merchant-scoped read)
// ---------------------------------------------------------------------------

export type MerchantFulfillmentRequest = {
  id: string;
  providerId: number;
  medusaOrderId: string;
  state: string;
  deliveryOrderId: number | null;
  deliveryReference: string | null;
  failureReason: string | null;
  requestedAt: string;
  acceptedAt: string | null;
  updatedAt: string;
};

/**
 * Merchant-scoped inbox over commerce.fulfillment_request. NOT the operator
 * SQL fn (0046:168 is hard is_platform_operator) — this query pins
 * provider_id to the caller's authorized portal
 * (roles: owner|inventory_manager, see FULFILLMENT_ROLES).
 */
export async function listMyFulfillmentRequests(input: {
  actorUserId: number;
  providerId: number;
  status?: string;
  limit?: number;
}): Promise<MerchantFulfillmentRequest[]> {
  const pool = await getPool();
  await authorizeMerchantPortal(
    pool,
    input.actorUserId,
    input.providerId,
    FULFILLMENT_ROLES,
  ).catch(mapMerchantSqlError);
  const result = await pool.query<{
    id: string;
    provider_id: number;
    medusa_order_id: string;
    state: string;
    delivery_order_id: number | null;
    delivery_reference: string | null;
    failure_reason: string | null;
    requested_at: string;
    accepted_at: string | null;
    updated_at: string;
  }>(
    `SELECT id, provider_id, medusa_order_id, state::text AS state,
            delivery_order_id, delivery_reference, failure_reason,
            requested_at, accepted_at, updated_at
     FROM commerce.fulfillment_request
     WHERE provider_id = $1
       AND ($2::commerce.fulfillment_state IS NULL OR state = $2)
     ORDER BY requested_at DESC, id DESC
     LIMIT $3`,
    [input.providerId, input.status ?? null, input.limit ?? 50],
  );
  return result.rows.map((row) => ({
    id: row.id,
    providerId: Number(row.provider_id),
    medusaOrderId: row.medusa_order_id,
    state: row.state,
    deliveryOrderId: row.delivery_order_id,
    deliveryReference: row.delivery_reference,
    failureReason: row.failure_reason,
    requestedAt: row.requested_at,
    acceptedAt: row.accepted_at,
    updatedAt: row.updated_at,
  }));
}

// ---------------------------------------------------------------------------
// 4. transitionMyFulfillment (merchant-legal edges only)
// ---------------------------------------------------------------------------

export type MerchantFulfillmentTransition = {
  fulfillmentId: string;
  providerId: number;
  previousState: string;
  state: string;
  replayed: boolean;
};

/**
 * Merchant subset of the 0046 state machine:
 *   accept → requested→accepted; reject → requested→cancelled; ready →
 *   accepted→accepted as a 'commerce.fulfillment.ready' evidence event (no
 *   ready state exists in commerce.fulfillment_state — documented deviation;
 *   assignment/dispatch remain operator-only).
 *
 * Mirrors commerce.transition_fulfillment's discipline (row lock FOR UPDATE,
 * idempotent replay via fulfillment_event.idempotency_key, timestamp CHECKs,
 * sequenced append-only event) because the SQL fn itself is hard
 * operator-only and cannot be wrapped for merchants. Provider ownership is
 * enforced by authorize_merchant_portal on the request's provider (42501 →
 * FORBIDDEN when the fulfillment belongs to another merchant).
 */
export async function transitionMyFulfillment(input: {
  actorUserId: number;
  fulfillmentId: string;
  action: "accept" | "reject" | "ready";
  reason?: string;
  idempotencyKey: string;
}): Promise<MerchantFulfillmentTransition> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{
      id: string;
      provider_id: number;
      state: string;
    }>(
      `SELECT id, provider_id, state::text AS state
       FROM commerce.fulfillment_request
       WHERE id = $1::uuid
       FOR UPDATE`,
      [input.fulfillmentId],
    );
    const request = locked.rows[0];
    if (!request) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "fulfillment_request_not_found",
      });
    }

    // Ownership: the request's provider must be one the caller is authorized
    // for (raises 42501 'merchant access denied' / 23514 'active merchant
    // required' otherwise).
    await authorizeMerchantPortal(
      client,
      input.actorUserId,
      Number(request.provider_id),
      FULFILLMENT_ROLES,
    ).catch(mapMerchantSqlError);

    // Idempotent replay: same key already recorded → return current state.
    const replay = await client.query(
      `SELECT 1 FROM commerce.fulfillment_event
       WHERE fulfillment_request_id = $1 AND idempotency_key = $2`,
      [input.fulfillmentId, input.idempotencyKey],
    );
    if (replay.rows.length > 0) {
      await client.query("COMMIT");
      return {
        fulfillmentId: input.fulfillmentId,
        providerId: Number(request.provider_id),
        previousState: request.state,
        state: request.state,
        replayed: true,
      };
    }

    const current = request.state;
    let nextState: string;
    let eventType: string;
    let stateChanged = true;
    if (input.action === "accept" && current === "requested") {
      nextState = "accepted";
      eventType = "commerce.fulfillment.accepted";
    } else if (input.action === "reject" && current === "requested") {
      nextState = "cancelled";
      eventType = "commerce.fulfillment.cancelled";
    } else if (input.action === "ready" && current === "accepted") {
      nextState = "accepted"; // evidence-only edge: no state change
      eventType = "commerce.fulfillment.ready";
      stateChanged = false;
    } else {
      throw new TRPCError({
        code: "CONFLICT",
        message: "invalid_fulfillment_transition",
      });
    }

    const detail = JSON.stringify({
      action: input.action,
      ...(input.reason ? { reason: input.reason } : {}),
    });

    if (stateChanged) {
      // Mirrors the 0046 timestamp CHECKs: accepted needs accepted_at,
      // cancelled needs cancelled_at.
      await client.query(
        `UPDATE commerce.fulfillment_request
         SET state = $2::commerce.fulfillment_state,
             accepted_at = CASE WHEN $2 = 'accepted' THEN now() ELSE accepted_at END,
             cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE cancelled_at END,
             updated_at = now()
         WHERE id = $1::uuid`,
        [input.fulfillmentId, nextState],
      );
    }

    const sequence = await client.query<{ next: number }>(
      `SELECT COALESCE(max(sequence_no), 0) + 1 AS next
       FROM commerce.fulfillment_event
       WHERE fulfillment_request_id = $1`,
      [input.fulfillmentId],
    );
    await client.query(
      `INSERT INTO commerce.fulfillment_event (
         fulfillment_request_id, sequence_no, actor_user_id, event_type,
         previous_state, next_state, detail, idempotency_key, created_at
       ) VALUES ($1,$2,$3,$4,$5::commerce.fulfillment_state,$6::commerce.fulfillment_state,$7::jsonb,$8,now())`,
      [
        input.fulfillmentId,
        Number(sequence.rows[0].next),
        input.actorUserId,
        eventType,
        current,
        nextState,
        detail,
        input.idempotencyKey,
      ],
    );
    await client.query("COMMIT");
    return {
      fulfillmentId: input.fulfillmentId,
      providerId: Number(request.provider_id),
      previousState: current,
      state: nextState,
      replayed: false,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    mapMerchantSqlError(error);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// 5. myEarnings (read-only aggregates)
// ---------------------------------------------------------------------------

export type MerchantEarnings = {
  providerId: number;
  /** All orders attributed to this provider (any status). */
  orderCount: number;
  deliveredOrderCount: number;
  /**
   * Gross over DELIVERED orders, legacy varchar MAJOR units summed via
   * ::numeric cast (documented: orders.total_amount is a major-unit string
   * per 0104; the numeric sum is returned as its exact decimal text).
   */
  grossDeliveredMajor: string;
  currency: string;
  /** commerce.fulfillment_request counts keyed by state. */
  fulfillmentsByState: Record<string, number>;
  /** Settlement configuration present + enabled. NEVER the reference itself. */
  payoutConfigured: boolean;
};

export async function getMyEarnings(input: {
  actorUserId: number;
  providerId: number;
}): Promise<MerchantEarnings> {
  const pool = await getPool();
  const context = await authorizeMerchantPortal(
    pool,
    input.actorUserId,
    input.providerId,
    FINANCE_ROLES,
  ).catch(mapMerchantSqlError);

  // Orders attribution: P1 consumer_checkout writes service_provider_id
  // (0104:259); legacy rows used provider_id — COALESCE covers both.
  const orders = await pool.query<{
    order_count: string;
    delivered_count: string;
    gross_delivered_major: string;
  }>(
    `SELECT count(*)::text AS order_count,
            count(*) FILTER (WHERE status::text = 'delivered')::text AS delivered_count,
            COALESCE(
              sum(total_amount::numeric) FILTER (WHERE status::text = 'delivered'),
              0
            )::text AS gross_delivered_major
     FROM public.orders
     WHERE COALESCE(service_provider_id, provider_id) = $1`,
    [input.providerId],
  );

  const fulfillments = await pool.query<{ state: string; count: string }>(
    `SELECT state::text AS state, count(*)::text AS count
     FROM commerce.fulfillment_request
     WHERE provider_id = $1
     GROUP BY state`,
    [input.providerId],
  );
  const fulfillmentsByState: Record<string, number> = {};
  for (const row of fulfillments.rows) {
    fulfillmentsByState[row.state] = Number(row.count);
  }

  const payout = await pool.query<{ configured: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM commerce.merchant_payment_configuration
       WHERE provider_id = $1 AND enabled
     ) AS configured`,
    [input.providerId],
  );

  const row = orders.rows[0];
  return {
    providerId: input.providerId,
    orderCount: Number(row?.order_count ?? 0),
    deliveredOrderCount: Number(row?.delivered_count ?? 0),
    grossDeliveredMajor: String(row?.gross_delivered_major ?? "0"),
    currency: context.currency_code ?? "NGN",
    fulfillmentsByState,
    payoutConfigured: payout.rows[0]?.configured === true,
  };
}

// ---------------------------------------------------------------------------
// 6. updateStorefrontProfile (owner-only display fields)
// ---------------------------------------------------------------------------

export type StorefrontProfile = {
  providerId: number;
  displayName: string;
  businessName: string;
  address: string | null;
  latitude: string | null;
  longitude: string | null;
  category: string | null;
  replayed: boolean;
};

/**
 * Owner-only UPDATE of service_providers display columns. Writable here:
 * name (display name), address, latitude, longitude (+updated_at). NEVER
 * written: status, verification_status, rating, commission_rate,
 * completed_services (platform/operator-owned). Store hours are DEFERRED —
 * no column exists on service_providers (follow-up, no DDL this wave).
 * Idempotent via the consumer_processed_events ledger
 * ('merchant-selfserve','storefront-update', `${actor}:${key}`); replay
 * returns the current profile.
 */
export async function updateStorefrontProfile(input: {
  actorUserId: number;
  providerId: number;
  displayName?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  idempotencyKey: string;
}): Promise<StorefrontProfile> {
  if (
    input.displayName === undefined &&
    input.address === undefined &&
    input.latitude === undefined &&
    input.longitude === undefined
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "storefront_profile_no_changes",
    });
  }
  const pool = await getPool();
  const ledgerId = `${input.actorUserId}:${input.idempotencyKey}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await authorizeMerchantPortal(
      client,
      input.actorUserId,
      input.providerId,
      OWNER_ROLES,
    ).catch(mapMerchantSqlError);

    const stored = await client.query<{ result_json: unknown }>(
      `SELECT result_json FROM public.consumer_processed_events
       WHERE consumer_name = $1 AND topic = $2 AND event_id = $3`,
      [LEDGER_CONSUMER, STOREFRONT_TOPIC, ledgerId],
    );
    if (stored.rows[0]) {
      const current = await client.query<ProfileRow>(PROFILE_SELECT, [
        input.providerId,
      ]);
      await client.query("COMMIT");
      return { ...mapProfileRow(input.providerId, current.rows[0]), replayed: true };
    }

    const updated = await client.query<ProfileRow>(
      `UPDATE public.service_providers
       SET name = COALESCE($2, name),
           address = COALESCE($3, address),
           latitude = COALESCE($4, latitude),
           longitude = COALESCE($5, longitude),
           updated_at = now()
       WHERE id = $1
       RETURNING name, business_name, address, latitude, longitude, category`,
      [
        input.providerId,
        input.displayName ?? null,
        input.address ?? null,
        input.latitude === undefined ? null : String(input.latitude),
        input.longitude === undefined ? null : String(input.longitude),
      ],
    );
    if (!updated.rows[0]) {
      throw new TRPCError({ code: "NOT_FOUND", message: "provider_not_found" });
    }
    await recordLedger(client, STOREFRONT_TOPIC, ledgerId, {
      provider_id: input.providerId,
    });
    await client.query("COMMIT");
    return { ...mapProfileRow(input.providerId, updated.rows[0]), replayed: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    mapMerchantSqlError(error);
  } finally {
    client.release();
  }
}

type ProfileRow = {
  name: string;
  business_name: string;
  address: string | null;
  latitude: string | null;
  longitude: string | null;
  category: string | null;
};

const PROFILE_SELECT = `SELECT name, business_name, address, latitude, longitude, category
  FROM public.service_providers WHERE id = $1`;

function mapProfileRow(
  providerId: number,
  row: ProfileRow | undefined,
): Omit<StorefrontProfile, "replayed"> {
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "provider_not_found" });
  }
  return {
    providerId,
    displayName: row.name,
    businessName: row.business_name,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    category: row.category,
  };
}
