import { getPool } from "../db";

/**
 * GA onboarding checklist for the merchant commerce portal. Every signal is
 * derived from real PostgreSQL tables — nothing is fabricated:
 *
 * - profile    → commerce.merchant_portal row (legal/display name + store id)
 * - payments   → commerce.merchant_payment_configuration row
 * - product    → commerce.merchant_catalog_product rows
 * - inventory  → commerce.medusa_inventory_binding rows (Medusa gateway)
 * - storefront → commerce.medusa_store_connection or
 *                commerce.external_platform_connection rows (gateway channels)
 *
 * When the derived checklist first observes every item done, the server
 * persists onboarding_completed_at on commerce.merchant_portal (column added
 * by drizzle/0079_merchant_onboarding.sql).
 */

export type OnboardingChecklistItemKey =
  | "profile"
  | "payments"
  | "product"
  | "inventory"
  | "storefront";

export type OnboardingChecklistItem = {
  key: OnboardingChecklistItemKey;
  label: string;
  description: string;
  status: "done" | "pending";
  /** Anchor on /merchant-commerce or an app route for the relevant section. */
  href: string;
};

export type MerchantOnboardingSignals = {
  profile: {
    legalName: string | null;
    displayName: string | null;
    medusaStoreId: string | null;
    state: string | null;
    onboardingCompletedAt: string | null;
  } | null;
  paymentConfigured: boolean;
  productCount: number;
  inventoryRowCount: number;
  storefrontLinked: boolean;
};

export type MerchantOnboardingChecklist = {
  providerId: number;
  items: OnboardingChecklistItem[];
  completedCount: number;
  totalCount: number;
  complete: boolean;
  onboardingCompletedAt: string | null;
};

function nonBlank(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Pure derivation — unit-tested with fixture rows, no database access. */
export function deriveOnboardingChecklist(
  providerId: number,
  signals: MerchantOnboardingSignals,
): MerchantOnboardingChecklist {
  const profileDone =
    signals.profile !== null &&
    nonBlank(signals.profile.legalName) &&
    nonBlank(signals.profile.displayName) &&
    nonBlank(signals.profile.medusaStoreId);

  const items: OnboardingChecklistItem[] = [
    {
      key: "profile",
      label: "Complete merchant profile",
      description:
        "Legal business name, store display name, and Medusa store ID registered through merchant onboarding.",
      status: profileDone ? "done" : "pending",
      href: "#merchant-onboarding-form",
    },
    {
      key: "payments",
      label: "Configure platform payments",
      description:
        "A settlement destination is recorded in the merchant payment configuration.",
      status: signals.paymentConfigured ? "done" : "pending",
      href: "#merchant-payments-form",
    },
    {
      key: "product",
      label: "Create your first product",
      description:
        "At least one catalog product is recorded against your merchant portal.",
      status: signals.productCount > 0 ? "done" : "pending",
      href: "#merchant-product-form",
    },
    {
      key: "inventory",
      label: "Link inventory",
      description:
        "At least one Medusa inventory binding exists for your stock locations.",
      status: signals.inventoryRowCount > 0 ? "done" : "pending",
      href: "#merchant-inventory-form",
    },
    {
      key: "storefront",
      label: "Link storefront or channels",
      description:
        "An active Medusa store connection or external commerce channel is registered.",
      status: signals.storefrontLinked ? "done" : "pending",
      href: "/commerce-fulfillment",
    },
  ];

  const completedCount = items.filter((item) => item.status === "done").length;
  return {
    providerId,
    items,
    completedCount,
    totalCount: items.length,
    complete: completedCount === items.length,
    onboardingCompletedAt: signals.profile?.onboardingCompletedAt ?? null,
  };
}

export class MerchantOnboardingError extends Error {}

type PortalRow = {
  state: string;
  legal_name: string;
  display_name: string;
  medusa_store_id: string;
  onboarding_completed_at: Date | string | null;
};

type SignalCountsRow = {
  payment_configured: boolean;
  product_count: string;
  inventory_row_count: string;
  storefront_linked: boolean;
};

/**
 * Load the checklist for a merchant the actor is a member of (or a commerce
 * operator for). Membership is checked in PostgreSQL; unlike the active-only
 * portal authorization, onboarding progress must be visible while the portal
 * is still in draft or verification_pending.
 */
export async function getMerchantOnboardingProgress(input: {
  actorUserId: number;
  providerId: number;
}): Promise<MerchantOnboardingChecklist> {
  if (!Number.isInteger(input.providerId) || input.providerId <= 0) {
    throw new MerchantOnboardingError("invalid_provider_id");
  }
  const pool = await getPool();

  const access = await pool.query<{ allowed: boolean }>(
    `SELECT (
       EXISTS (
         SELECT 1 FROM commerce.merchant_user_access a
         WHERE a.provider_id = $2 AND a.user_id = $1 AND a.active
       )
       OR EXISTS (
         SELECT 1 FROM public.users u
         WHERE u.id = $1 AND u.role::text IN ('admin','platform_admin','super_admin')
       )
     ) AS allowed`,
    [input.actorUserId, input.providerId],
  );
  if (access.rows[0]?.allowed !== true) {
    throw new MerchantOnboardingError("merchant_access_denied");
  }

  const portal = await pool.query<PortalRow>(
    `SELECT state::text, legal_name, display_name, medusa_store_id, onboarding_completed_at
     FROM commerce.merchant_portal WHERE provider_id = $1`,
    [input.providerId],
  );
  const portalRow = portal.rows[0] ?? null;

  const counts = await pool.query<SignalCountsRow>(
    `SELECT
       EXISTS (
         SELECT 1 FROM commerce.merchant_payment_configuration
         WHERE provider_id = $1
       ) AS payment_configured,
       (SELECT count(*)::text FROM commerce.merchant_catalog_product
         WHERE provider_id = $1) AS product_count,
       (SELECT count(*)::text FROM commerce.medusa_inventory_binding
         WHERE provider_id = $1 AND active) AS inventory_row_count,
       (
         EXISTS (
           SELECT 1 FROM commerce.medusa_store_connection
           WHERE provider_id = $1 AND active
         )
         OR EXISTS (
           SELECT 1 FROM commerce.external_platform_connection
           WHERE provider_id = $1 AND state = 'active'
         )
       ) AS storefront_linked`,
    [input.providerId],
  );
  const countRow = counts.rows[0];

  const checklist = deriveOnboardingChecklist(input.providerId, {
    profile: portalRow
      ? {
          legalName: portalRow.legal_name,
          displayName: portalRow.display_name,
          medusaStoreId: portalRow.medusa_store_id,
          state: portalRow.state,
          onboardingCompletedAt: portalRow.onboarding_completed_at
            ? new Date(portalRow.onboarding_completed_at).toISOString()
            : null,
        }
      : null,
    paymentConfigured: countRow?.payment_configured === true,
    productCount: Number(countRow?.product_count ?? 0),
    inventoryRowCount: Number(countRow?.inventory_row_count ?? 0),
    storefrontLinked: countRow?.storefront_linked === true,
  });

  // First observation of full completion persists the completion signal.
  if (checklist.complete && checklist.onboardingCompletedAt === null && portalRow) {
    const completed = await pool.query<{ onboarding_completed_at: Date | string }>(
      `UPDATE commerce.merchant_portal
       SET onboarding_completed_at = now(), updated_at = now()
       WHERE provider_id = $1 AND onboarding_completed_at IS NULL
       RETURNING onboarding_completed_at`,
      [input.providerId],
    );
    const recorded = completed.rows[0]?.onboarding_completed_at;
    if (recorded) {
      checklist.onboardingCompletedAt = new Date(recorded).toISOString();
    }
  }

  return checklist;
}
