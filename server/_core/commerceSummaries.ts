import { getPool } from "../db";

/**
 * Real replacements for the former fail-closed summary functions in
 * server/db.ts (removed in the gap-closure round). Every metric here is
 * computed from live tables; lists that describe product capabilities (channel
 * names, call-flow labels) are static copy, never fabricated counts.
 *
 * These functions return honest zeros and empty arrays when the underlying
 * tables have no rows, so callers can render truthful empty states.
 */

export interface MerchantChannelsSummaryResult {
  summary: {
    branded_storefronts: number;
    direct_ordering_widgets: number;
    crm_playbooks: number;
    support_automation_flows: number;
    recommended_action: string;
  };
  storefronts: Array<{
    id: number;
    name: string;
    category: string | null;
    status: string | null;
    rating: number;
    storefront_state: "live" | "not_enabled";
  }>;
  owned_channels: string[];
  campaigns: Array<{
    id: number;
    name: string;
    channel: string | null;
    status: string | null;
    budget: number | null;
    spent: number | null;
  }>;
}

export async function getMerchantChannelsSummary(
  limit = 8,
): Promise<MerchantChannelsSummaryResult> {
  const pool = await getPool();
  const bounded = Math.max(1, Math.min(limit, 50));

  const [providerResult, campaignResult, whiteLabelResult, tablesideResult] =
    await Promise.all([
      pool.query(
        `SELECT id, business_name, category, status, rating
         FROM service_providers
         ORDER BY rating DESC NULLS LAST, business_name ASC
         LIMIT $1`,
        [bounded],
      ),
      pool.query(
        `SELECT id, name, channel, status, budget, spent
         FROM marketing_campaigns
         ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
         LIMIT $1`,
        [bounded],
      ),
      // White-label branded apps and tableside QR venues are real channel
      // inventory once migrations 0075/0076 are applied.
      pool.query(
        `SELECT COUNT(*)::int AS apps FROM white_label_apps WHERE status = 'live'`,
      ),
      pool.query(
        `SELECT COUNT(*)::int AS venues FROM tableside_venues WHERE qr_enabled`,
      ),
    ]);

  const providers = providerResult.rows as any[];
  const campaigns = campaignResult.rows as any[];
  const liveBrandedApps = Number(whiteLabelResult.rows[0]?.apps ?? 0);
  const qrVenues = Number(tablesideResult.rows[0]?.venues ?? 0);
  const activeCampaigns = campaigns.filter(
    (row) => String(row.status || "").toLowerCase() === "active",
  ).length;

  return {
    summary: {
      branded_storefronts: liveBrandedApps,
      direct_ordering_widgets: qrVenues,
      crm_playbooks: activeCampaigns,
      support_automation_flows: 0, // no automation-flow registry exists yet; honestly zero
      recommended_action:
        liveBrandedApps === 0 && qrVenues === 0
          ? "No first-party merchant channels are live yet — launch a white-label app or enable tableside QR venues to activate owned channels."
          : "Grow owned-channel coverage by activating white-label apps and tableside QR for top-rated merchants.",
    },
    storefronts: providers.slice(0, bounded).map((row) => ({
      id: Number(row.id),
      name: row.business_name,
      category: row.category ?? null,
      status: row.status ?? null,
      rating: Number(Number(row.rating || 0).toFixed(1)),
      storefront_state: "not_enabled" as const,
    })),
    owned_channels: [
      "Hosted web storefront",
      "Embedded ordering widget",
      "White-label branded app",
      "Phone ordering agent",
      "Tableside QR ordering",
      "CRM-triggered reorder campaigns",
    ],
    campaigns: campaigns.slice(0, bounded).map((row) => ({
      id: Number(row.id),
      name: row.name,
      channel: row.channel ?? null,
      status: row.status ?? null,
      budget: row.budget === null || row.budget === undefined ? null : Number(row.budget),
      spent: row.spent === null || row.spent === undefined ? null : Number(row.spent),
    })),
  };
}

export interface PhoneOrderingSummaryResult {
  summary: {
    live_lines: number;
    ai_agents: number;
    escalations_today: number;
    recovered_orders: number;
    recommended_action: string;
  };
  call_flows: Array<{ id: number; name: string; automation: string }>;
  lines: Array<{
    id: number;
    brand: string;
    category: string | null;
    status: string | null;
    queue_sla_seconds: number | null;
  }>;
}

export async function getPhoneOrderingSummary(
  limit = 8,
): Promise<PhoneOrderingSummaryResult> {
  const pool = await getPool();
  const bounded = Math.max(1, Math.min(limit, 50));

  const [providerResult, ticketResult, voiceSessionResult] = await Promise.all([
    pool.query(
      `SELECT id, business_name, category, status
       FROM service_providers
       ORDER BY created_at DESC NULLS LAST
       LIMIT $1`,
      [bounded],
    ),
    pool.query(
      `SELECT id, status, priority, created_at
       FROM support_tickets
       WHERE created_at >= NOW() - INTERVAL '1 day'
       ORDER BY created_at DESC NULLS LAST
       LIMIT 200`,
    ),
    // Live voice session volume from the LongCat voice pipeline.
    pool.query(
      `SELECT COUNT(*)::int AS sessions
       FROM longcat_voice_sessions
       WHERE created_at >= NOW() - INTERVAL '1 day'`,
    ),
  ]);

  const providers = providerResult.rows as any[];
  const ticketsToday = ticketResult.rows as any[];
  const escalationsToday = ticketsToday.filter((row) =>
    ["urgent", "critical"].includes(String(row.priority || "").toLowerCase()),
  ).length;
  const voiceSessionsToday = Number(voiceSessionResult.rows[0]?.sessions ?? 0);

  return {
    summary: {
      live_lines: voiceSessionsToday,
      ai_agents: voiceSessionsToday > 0 ? 1 : 0, // one self-hosted LongCat assistant when traffic exists
      escalations_today: escalationsToday,
      recovered_orders: 0, // recovery attribution is not instrumented; honestly zero
      recommended_action:
        voiceSessionsToday === 0
          ? "No voice-ordering sessions in the last 24h — verify the voice gateway and speech runtime are connected before promoting phone ordering."
          : "Voice ordering is receiving live sessions; review escalations and recovered-order handling with the merchant team.",
    },
    call_flows: [
      { id: 1, name: "Order capture", automation: "voice agent + cart confirm" },
      { id: 2, name: "Store call deflection", automation: "FAQ + status lookup" },
      { id: 3, name: "Support recovery", automation: "refund triage + escalation" },
      { id: 4, name: "Healthcare scheduling", automation: "eligibility + pickup intake" },
    ],
    lines: providers.slice(0, bounded).map((row) => ({
      id: Number(row.id),
      brand: row.business_name,
      category: row.category ?? null,
      status: row.status ?? null,
      queue_sla_seconds: null, // queue SLA is not instrumented per line
    })),
  };
}
