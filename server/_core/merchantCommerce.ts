/**
 * Merchant commerce portal (F4): onboarding, catalog, and order operations
 * behind commerce.* SQL functions (drizzle/0064) plus an optional Medusa
 * gateway for storefront projection. Medusa remains optional infrastructure:
 * when MEDUSA_MERCHANT_API_URL/TOKEN are not configured, onboarding and
 * catalog stay fully functional on the Postgres ledger and Medusa-dependent
 * operations fail closed with a domain error instead of crashing the app.
 */
import { Pool } from "pg";
import { ENV } from "./env";
import { sendEmail, sendSMS } from "./notificationGateway";
import { resilientFetch } from "./resilientFetch";

let pool: Pool | null = null;
function database(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: ENV.databaseUrl, max: 4 });
  }
  return pool;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
function requireKey(key: string) {
  if (!IDEMPOTENCY_KEY.test(key)) throw new Error("invalid_idempotency_key");
}

export async function onboardMerchant(input: {
  actorUserId: number;
  providerId: number;
  displayName: string;
  ownerUserId: number;
  beneficiaryRef?: string | null;
  idempotencyKey: string;
}) {
  requireKey(input.idempotencyKey);
  const result = await database().query<{ id: string }>(
    `SELECT commerce.onboard_merchant($1,$2,$3,$4,$5,$6) AS id`,
    [
      input.actorUserId,
      input.providerId,
      input.displayName,
      input.ownerUserId,
      input.beneficiaryRef ?? null,
      input.idempotencyKey,
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("merchant_onboarding_failed");
  return { portalId: id };
}

export async function getMerchantOnboardingState(providerId: number) {
  const result = await database().query<{
    state: string;
    verification_case_id: string | null;
  }>(
    `SELECT state::text AS state, verification_case_id::text AS verification_case_id
       FROM commerce.merchant_portal WHERE provider_id = $1`,
    [providerId],
  );
  return result.rows[0] ?? null;
}

export async function claimMerchantOnboarding(input: {
  actorUserId: number;
  providerId: number;
  verificationCaseId: string;
  idempotencyKey: string;
}) {
  requireKey(input.idempotencyKey);
  const result = await database().query<{ state: string }>(
    `SELECT commerce.claim_merchant_onboarding($1,$2,$3::uuid,$4) AS state`,
    [
      input.actorUserId,
      input.providerId,
      input.verificationCaseId,
      input.idempotencyKey,
    ],
  );
  return { state: result.rows[0]?.state ?? "unknown" };
}

export async function activateMerchantOnboarding(input: {
  actorUserId: number;
  providerId: number;
  verificationCaseId: string;
  idempotencyKey: string;
}) {
  requireKey(input.idempotencyKey);
  const result = await database().query<{ state: string }>(
    `SELECT commerce.activate_merchant_onboarding($1,$2,$3::uuid,$4) AS state`,
    [
      input.actorUserId,
      input.providerId,
      input.verificationCaseId,
      input.idempotencyKey,
    ],
  );
  return { state: result.rows[0]?.state ?? "unknown" };
}

export async function decideMerchantOnboarding(input: {
  actorUserId: number;
  providerId: number;
  decision: "activate" | "suspend" | "reject";
  verificationCaseId?: string | null;
  rejectionReason?: string | null;
  idempotencyKey: string;
}) {
  const result = await database().query<{ state: string }>(
    `SELECT commerce.decide_merchant_onboarding($1,$2,$3,$4::uuid,$5) AS state`,
    [
      input.actorUserId,
      input.providerId,
      input.decision,
      input.verificationCaseId ?? null,
      input.idempotencyKey,
    ],
  );
  const state = result.rows[0]?.state ?? "unknown";
  // Persist the operator-supplied rejection reason (drizzle/0092 column) so
  // a rejected merchant can see why; the DB function signature is unchanged.
  if (input.decision === "reject" && input.rejectionReason?.trim()) {
    await database().query(
      `UPDATE commerce.merchant_portal
       SET rejection_reason = $2, updated_at = now()
       WHERE provider_id = $1`,
      [input.providerId, input.rejectionReason.trim()],
    );
  }
  // Notify the merchant owner of the onboarding decision. Fail-open: a
  // notification outage never blocks the decision (Audit A P1-8).
  await notifyMerchantOnboardingDecision(
    input.providerId,
    input.decision,
    state,
    input.rejectionReason ?? null,
  );
  return { state };
}

async function notifyMerchantOnboardingDecision(
  providerId: number,
  decision: "activate" | "suspend" | "reject",
  state: string,
  rejectionReason: string | null,
): Promise<void> {
  try {
    const owner = await database().query<{ owner_user_id: number }>(
      `SELECT owner_user_id FROM commerce.merchant_portal WHERE provider_id = $1`,
      [providerId],
    );
    const ownerUserId = owner.rows[0]?.owner_user_id;
    if (ownerUserId == null) return;
    const contact = await database().query<{
      email: string | null;
      phone: string | null;
    }>(`SELECT email, phone FROM public.users WHERE id = $1`, [ownerUserId]);
    const user = contact.rows[0];
    const reasonSuffix =
      decision === "reject" && rejectionReason?.trim()
        ? ` Reason: ${rejectionReason.trim()}`
        : "";
    const message = `Your merchant onboarding (provider ${providerId}) was decided: ${state}.${reasonSuffix}`;
    const metadata = {
      notificationType: "merchant.onboarding.decided",
      providerId: `${providerId}`,
      decision,
      state,
    };
    if (user?.email) {
      await sendEmail(
        user.email,
        "SwitchOS merchant onboarding decision",
        message,
        metadata,
      );
    } else if (user?.phone) {
      await sendSMS(user.phone, message, metadata);
    }
  } catch (error) {
    console.warn(
      "[merchantCommerce] onboarding decision notification failed; continuing",
      error,
    );
  }
}

export async function upsertMerchantProduct(input: {
  actorUserId: number;
  providerId: number;
  sku: string;
  title: string;
  priceMinor: number;
  currency: string;
  idempotencyKey: string;
}) {
  requireKey(input.idempotencyKey);
  const result = await database().query<{ id: string }>(
    `SELECT commerce.upsert_product($1,$2,$3,$4,$5,$6,$7) AS id`,
    [
      input.actorUserId,
      input.providerId,
      input.sku,
      input.title,
      input.priceMinor,
      input.currency,
      input.idempotencyKey,
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("merchant_product_upsert_failed");
  return { productId: id };
}

export async function listMerchantProducts(providerId: number) {
  const result = await database().query(
    `SELECT id::text AS id, sku, title, price_minor AS "priceMinor", currency,
            active, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM commerce.product WHERE provider_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [providerId],
  );
  return result.rows;
}

export async function listMerchantOrders(providerId: number) {
  const result = await database().query(
    `SELECT id::text AS id, status::text AS status, total_minor AS "totalMinor",
            currency, created_at AS "createdAt"
       FROM commerce.order WHERE provider_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [providerId],
  );
  return result.rows;
}

/** Medusa storefront projection (optional dependency, fails closed). */
export async function getMerchantCommerceProfile(providerId: number) {
  const portal = await database().query<{
    display_name: string;
    state: string;
    medusa_store_id: string | null;
  }>(
    `SELECT display_name, state::text AS state, medusa_store_id
       FROM commerce.merchant_portal WHERE provider_id = $1`,
    [providerId],
  );
  const row = portal.rows[0];
  if (!row) return null;
  if (!ENV.medusaMerchantConfigured) {
    return {
      providerId,
      displayName: row.display_name,
      state: row.state,
      medusa: { configured: false },
    };
  }
  if (!row.medusa_store_id) {
    return {
      providerId,
      displayName: row.display_name,
      state: row.state,
      medusa: { configured: true, linked: false },
    };
  }
  const response = await resilientFetch(
    `${ENV.medusaMerchantApiUrl}/stores/${row.medusa_store_id}`,
    {
      headers: { authorization: `Bearer ${ENV.medusaMerchantApiToken}` },
      timeoutMs: 5_000,
      maxAttempts: 1,
    },
  );
  if (!response.ok) {
    throw new Error(`medusa_store_lookup_failed:${response.status}`);
  }
  const body = (await response.json()) as { store?: { name?: string } };
  return {
    providerId,
    displayName: row.display_name,
    state: row.state,
    medusa: {
      configured: true,
      linked: true,
      storeName: body.store?.name ?? null,
    },
  };
}
