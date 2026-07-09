import pg from "pg";

import { buildConsumerAssistant, buildDispatchIntelligence, buildMerchantConsultant } from "../_core/longcat";
import { ENV } from "../_core/env";
import { getLongCatCustomerMemory } from "../_core/longcatVoice";

type Driver = {
  id: number;
  name: string;
  mode: "ride" | "delivery" | "airport" | "healthcare";
  zone: string;
  rating: number;
  reliability: number;
  online: boolean;
  weeklyEarnings: number;
  airportReady: boolean;
  tripRadarEligible: boolean;
  currentLoad: number;
};

type DiningVenue = {
  id: number;
  name: string;
  city: string;
  qrEnabled: boolean;
  activeSessions: number;
  payAtTableEnabled: boolean;
  upsellModules: string[];
  launchStage: "pilot" | "rolled_out" | "expanding";
};

type WhiteLabelBrand = {
  id: number;
  brand: string;
  tenant: string;
  audience: "merchant" | "courier" | "rider" | "enterprise";
  releaseTrack: "pilot" | "beta" | "general";
  pushReady: boolean;
  launched: boolean;
};

const { Pool } = pg;
let pool: pg.Pool | null = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      ssl: ENV.databaseUrl.includes("sslmode=require") ? { rejectUnauthorized: false } : false,
    });
  }
  return pool;
}

async function queryOne<T extends Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T | null> {
  const result = await getPool().query(sql, values);
  return (result.rows[0] as T | undefined) ?? null;
}

function toNumber(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

const drivers: Driver[] = [
  { id: 101, name: "Amina Okafor", mode: "ride", zone: "Airport", rating: 4.9, reliability: 97, online: true, weeklyEarnings: 820, airportReady: true, tripRadarEligible: true, currentLoad: 1 },
  { id: 102, name: "David Mensah", mode: "delivery", zone: "Victoria Island", rating: 4.7, reliability: 94, online: true, weeklyEarnings: 760, airportReady: false, tripRadarEligible: true, currentLoad: 2 },
  { id: 103, name: "Chika Ibe", mode: "healthcare", zone: "Lekki", rating: 4.8, reliability: 96, online: true, weeklyEarnings: 790, airportReady: false, tripRadarEligible: false, currentLoad: 1 },
  { id: 104, name: "Kofi Boateng", mode: "airport", zone: "Airport", rating: 4.6, reliability: 91, online: false, weeklyEarnings: 680, airportReady: true, tripRadarEligible: true, currentLoad: 0 },
  { id: 105, name: "Fatima Bello", mode: "delivery", zone: "Yaba", rating: 4.8, reliability: 95, online: true, weeklyEarnings: 735, airportReady: false, tripRadarEligible: true, currentLoad: 1 },
];

const venues: DiningVenue[] = [
  { id: 201, name: "Harbor Grill", city: "Lagos", qrEnabled: true, activeSessions: 34, payAtTableEnabled: true, upsellModules: ["dessert prompts", "wine pairings"], launchStage: "rolled_out" },
  { id: 202, name: "Metro Bistro", city: "Abuja", qrEnabled: true, activeSessions: 21, payAtTableEnabled: false, upsellModules: ["combo upgrades"], launchStage: "expanding" },
  { id: 203, name: "Palm Court", city: "Port Harcourt", qrEnabled: true, activeSessions: 16, payAtTableEnabled: true, upsellModules: ["table reorder", "loyalty capture"], launchStage: "pilot" },
];

const brands: WhiteLabelBrand[] = [
  { id: 301, brand: "SwiftCart", tenant: "Urban Retail Group", audience: "merchant", releaseTrack: "general", pushReady: true, launched: true },
  { id: 302, brand: "RideNXT", tenant: "Metro Mobility Co", audience: "rider", releaseTrack: "beta", pushReady: true, launched: true },
  { id: 303, brand: "CourierFlow", tenant: "Parcel Ops Africa", audience: "courier", releaseTrack: "pilot", pushReady: false, launched: false },
  { id: 304, brand: "ExecTrips", tenant: "Business Travel Desk", audience: "enterprise", releaseTrack: "beta", pushReady: true, launched: false },
];

export function getAnalyticsSummary() {
  const onlineDrivers = drivers.filter((driver) => driver.online);
  const activeDiningSessions = venues.reduce((sum, venue) => sum + venue.activeSessions, 0);
  const liveBrands = brands.filter((brand) => brand.launched).length;

  return {
    source: "platform-workspace",
    generated_at: new Date().toISOString(),
    summary: {
      online_drivers: onlineDrivers.length,
      active_dining_sessions: activeDiningSessions,
      branded_apps_live: liveBrands,
      recommended_action: "Prioritize airport supply balancing and pay-at-table rollout for expansion venues.",
    },
  };
}

export function getOrderStats() {
  return {
    total: 1842,
    active: 128,
    delayed: 19,
    completed_today: 276,
  };
}

export function getDriverStats() {
  const onlineDrivers = drivers.filter((driver) => driver.online);
  return {
    total: drivers.length,
    online: onlineDrivers.length,
    airport_ready: drivers.filter((driver) => driver.airportReady).length,
    trip_radar_candidates: drivers.filter((driver) => driver.tripRadarEligible).length,
  };
}

export function getMarketplaceOverview() {
  const hotspots = [
    {
      zone_key: "Airport",
      pressure_band: "critical",
      pressure_ratio: 2.3,
      waiting_orders: 18,
      open_orders: 26,
      available_drivers: 7,
      avg_wait_minutes: 13.4,
      recommended_action: "Shift two delivery-capable airport-ready drivers into transfer coverage for the next 45 minutes.",
    },
    {
      zone_key: "Victoria Island",
      pressure_band: "elevated",
      pressure_ratio: 1.6,
      waiting_orders: 11,
      open_orders: 19,
      available_drivers: 8,
      avg_wait_minutes: 9.1,
      recommended_action: "Open batch windows for nearby delivery routes and tighten promised ETAs.",
    },
    {
      zone_key: "Lekki",
      pressure_band: "balanced",
      pressure_ratio: 1.1,
      waiting_orders: 6,
      open_orders: 10,
      available_drivers: 9,
      avg_wait_minutes: 6.2,
      recommended_action: "Maintain current staffing and monitor healthcare-transport spillover.",
    },
  ];

  return {
    queue: {
      pending_orders: 54,
      avg_queue_minutes: 8.7,
    },
    drivers: {
      available_drivers: drivers.filter((driver) => driver.online).length,
    },
    activity_signals: {
      assignment_events_7d: 1384,
    },
    hotspots,
  };
}

export async function getDriverMobilityWorkspace(limit = 8) {
  const supplyQueue = drivers.slice(0, limit).map((driver) => ({
    driver: driver.name,
    mode: driver.mode,
    zone: driver.zone,
    rating: driver.rating,
    reliability: `${driver.reliability}%`,
    weekly_earnings: `$${driver.weeklyEarnings}`,
    status: driver.online ? "online" : "offline",
    next_action: driver.tripRadarEligible ? "Eligible for trip radar and batch offers" : "Specialized dispatch only",
  }));

  const summary = {
    online_drivers: drivers.filter((driver) => driver.online).length,
    trip_radar_candidates: drivers.filter((driver) => driver.tripRadarEligible).length,
    airport_ready_drivers: drivers.filter((driver) => driver.airportReady).length,
    avg_weekly_earnings: Math.round(drivers.reduce((sum, driver) => sum + driver.weeklyEarnings, 0) / drivers.length),
    recommended_action: "Airport demand is outrunning reserve supply; rebalance one delivery-first cohort toward transfer readiness.",
  };

  return {
    summary,
    earning_streams: [
      "Airport reserve queue incentives",
      "Trip radar surge offers for mixed mobility and courier work",
      "Healthcare transport premiums for trained drivers",
      "High-reliability weekly guarantee programs",
    ],
    supply_queue: supplyQueue,
    longcat: await buildDispatchIntelligence({
      ...summary,
      supply_queue: supplyQueue,
    }),
  };
}

export function getTablesideWorkspace(limit = 8) {
  return {
    summary: {
      qr_venues: venues.filter((venue) => venue.qrEnabled).length,
      active_sessions: venues.reduce((sum, venue) => sum + venue.activeSessions, 0),
      pay_at_table_enablement: Math.round((venues.filter((venue) => venue.payAtTableEnabled).length / venues.length) * 100),
      upsell_modules: venues.reduce((sum, venue) => sum + venue.upsellModules.length, 0),
      recommended_action: "Move Metro Bistro from expansion to full pay-at-table enablement before the weekend dinner peak.",
    },
    order_modes: [
      "QR scan to self-serve ordering",
      "Staff-assisted order capture with shared table context",
      "Pay-at-table and split-bill workflows",
      "Hybrid dine-in to pickup conversion during queue spikes",
    ],
    venue_rollout: venues.slice(0, limit).map((venue) => ({
      venue: venue.name,
      city: venue.city,
      active_sessions: venue.activeSessions,
      pay_at_table: venue.payAtTableEnabled ? "enabled" : "pending",
      launch_stage: venue.launchStage,
      upsell_modules: venue.upsellModules.join(", "),
    })),
  };
}

export function getWhiteLabelAppsWorkspace(limit = 8) {
  const selected = brands.slice(0, limit);

  return {
    summary: {
      branded_apps_live: brands.filter((brand) => brand.launched).length,
      templates_available: 6,
      push_channels_ready: brands.filter((brand) => brand.pushReady).length,
      release_tracks: new Set(brands.map((brand) => brand.releaseTrack)).size,
      recommended_action: "Launch push-ready merchant templates first, then graduate courier brands once fallback messaging is fully wired.",
    },
    app_templates: [
      { name: "Merchant Growth Starter", audience: "merchant", release_track: "general" },
      { name: "Courier Ops Pilot", audience: "courier", release_track: "pilot" },
      { name: "Rider Marketplace Beta", audience: "rider", release_track: "beta" },
      { name: "Enterprise Travel Desk", audience: "enterprise", release_track: "beta" },
    ],
    brands: selected.map((brand) => ({
      brand: brand.brand,
      tenant: brand.tenant,
      audience: brand.audience,
      release_track: brand.releaseTrack,
      launch_status: brand.launched ? "live" : "prelaunch",
      push: brand.pushReady ? "ready" : "pending",
    })),
  };
}

export async function getMerchantChannelWorkspace() {
  try {
    const summary = await queryOne<{
      activated_channels: number | string;
      branded_storefronts: number | string;
      partner_channels: number | string;
      campaigns_running: number | string;
      recent_push_deliveries: number | string;
    }>(`
      SELECT
        COUNT(DISTINCT mc.channel) AS activated_channels,
        COUNT(DISTINCT sp.id) AS branded_storefronts,
        COUNT(DISTINCT CASE WHEN mc.channel IN ('marketplace', 'affiliate', 'partner') THEN mc.channel END) AS partner_channels,
        COUNT(DISTINCT mc.id) FILTER (WHERE COALESCE(mc.status, 'draft') IN ('active', 'running', 'scheduled')) AS campaigns_running,
        COUNT(pnl.id) FILTER (WHERE pnl.created_at >= NOW() - INTERVAL '7 days') AS recent_push_deliveries
      FROM service_providers sp
      LEFT JOIN marketing_campaigns mc ON TRUE
      LEFT JOIN push_notification_logs pnl ON TRUE
      WHERE COALESCE(sp.status, 'inactive') = 'active'
    `);

    const channelRows = await getPool().query<{ channel: string }>(`
      SELECT DISTINCT channel
      FROM marketing_campaigns
      WHERE channel IS NOT NULL AND channel <> ''
      ORDER BY channel ASC
      LIMIT 8
    `);

    const activatedChannels = toNumber(summary?.activated_channels);
    const brandedStorefronts = toNumber(summary?.branded_storefronts);
    const partnerChannels = toNumber(summary?.partner_channels);
    const recentPushDeliveries = toNumber(summary?.recent_push_deliveries);
    const campaignsRunning = toNumber(summary?.campaigns_running);

    const summaryPayload = {
      activated_channels: activatedChannels,
      branded_storefronts: brandedStorefronts,
      partner_channels: partnerChannels,
      recommended_action: campaignsRunning > 0
        ? `Stabilize ${campaignsRunning} live campaign channels and align push follow-through before opening additional storefront surfaces.`
        : "Activate owned storefront and messaging channels before expanding partner syndication.",
    };

    const channelMix = channelRows.rows.length > 0
      ? channelRows.rows.map((row) => `${row.channel} channel with ${recentPushDeliveries} push deliveries observed in the last 7 days`)
      : [
          "Owned web storefronts with active merchant records",
          "Managed campaign channels awaiting wider activation",
        ];

    return {
      summary: summaryPayload,
      channel_mix: channelMix,
      longcat: await buildMerchantConsultant({
        ...summaryPayload,
        channel_mix: channelMix,
      }),
    };
  } catch {
    const summaryPayload = {
      activated_channels: 5,
      branded_storefronts: 12,
      partner_channels: 3,
      recommended_action: "Focus the next release on merchant activation sequencing instead of adding more disconnected storefront CRUD.",
    };
    const channelMix = [
      "Owned web storefronts",
      "Branded mobile ordering",
      "Tableside ordering",
      "Phone-assisted capture",
      "Partner marketplace syndication",
    ];

    return {
      summary: summaryPayload,
      channel_mix: channelMix,
      longcat: await buildMerchantConsultant({
        ...summaryPayload,
        channel_mix: channelMix,
      }),
    };
  }
}

export async function getServiceRecoveryWorkspace() {
  try {
    const summary = await queryOne<{
      open_incidents: number | string;
      compensation_pending: number | string;
      recovered_orders: number | string;
      total_problem_orders: number | string;
    }>(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('pending', 'cancelled')) AS open_incidents,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS compensation_pending,
        COUNT(*) FILTER (WHERE status = 'completed') AS recovered_orders,
        COUNT(*) FILTER (WHERE status IN ('pending', 'cancelled', 'completed')) AS total_problem_orders
      FROM orders
      WHERE updated_at >= NOW() - INTERVAL '7 days'
    `);

    const queueRows = await getPool().query<{ queue_name: string; queue_size: number | string }>(`
      SELECT queue_name, queue_size
      FROM (
        SELECT 'Pending order follow-up' AS queue_name, COUNT(*) FILTER (WHERE status = 'pending') AS queue_size FROM orders WHERE updated_at >= NOW() - INTERVAL '7 days'
        UNION ALL
        SELECT 'Cancelled order compensation', COUNT(*) FILTER (WHERE status = 'cancelled') FROM orders WHERE updated_at >= NOW() - INTERVAL '7 days'
        UNION ALL
        SELECT 'Payment exception review', COUNT(*) FILTER (WHERE status NOT IN ('completed', 'settled')) FROM transactions WHERE updated_at >= NOW() - INTERVAL '7 days'
      ) queues
      ORDER BY queue_size DESC, queue_name ASC
    `);

    const openIncidents = toNumber(summary?.open_incidents);
    const compensationPending = toNumber(summary?.compensation_pending);
    const recoveredOrders = toNumber(summary?.recovered_orders);
    const totalProblemOrders = Math.max(1, toNumber(summary?.total_problem_orders));
    const saveRate = Math.round((recoveredOrders / totalProblemOrders) * 100);

    return {
      summary: {
        open_incidents: openIncidents,
        compensation_pending: compensationPending,
        save_rate: saveRate,
        recommended_action: compensationPending > 0
          ? `Work the ${compensationPending} cancelled-order compensation cases before they age into manual settlement backlog.`
          : "Open recovery queues are controlled; focus on automating payment-exception follow-through.",
      },
      queues: queueRows.rows.map((row) => `${row.queue_name}: ${toNumber(row.queue_size)} cases`) || ["No active recovery queues in the selected window"],
    };
  } catch {
    return {
      summary: {
        open_incidents: 14,
        compensation_pending: 5,
        save_rate: 82,
        recommended_action: "Escalate airport-delay incidents immediately and automate merchant credits for venue-side prep misses.",
      },
      queues: [
        "Airport delay recovery",
        "Missing-item compensation",
        "Merchant prep exceptions",
        "Courier reassignment and proactive outreach",
      ],
    };
  }
}

export async function getPhoneOrderingWorkspace() {
  try {
    const summary = await queryOne<{
      staffed_lines: number | string;
      active_calls: number | string;
      substitution_cases: number | string;
    }>(`
      SELECT
        GREATEST(1, COUNT(DISTINCT sp.id)) AS staffed_lines,
        COUNT(*) FILTER (WHERE status IN ('pending', 'accepted')) AS active_calls,
        COUNT(*) FILTER (WHERE notes ILIKE '%substitut%' OR notes ILIKE '%unavailable%' OR notes ILIKE '%call%') AS substitution_cases
      FROM service_providers sp
      LEFT JOIN orders o ON o.provider_id = sp.id AND o.updated_at >= NOW() - INTERVAL '24 hours'
      WHERE COALESCE(sp.status, 'inactive') = 'active'
    `);

    const flowRows = await getPool().query<{ flow_name: string; flow_volume: number | string }>(`
      SELECT flow_name, flow_volume
      FROM (
        SELECT 'Assisted order capture' AS flow_name, COUNT(*) FILTER (WHERE status IN ('pending', 'accepted')) AS flow_volume FROM orders WHERE updated_at >= NOW() - INTERVAL '24 hours'
        UNION ALL
        SELECT 'Substitution handling', COUNT(*) FILTER (WHERE notes ILIKE '%substitut%' OR notes ILIKE '%unavailable%') FROM orders WHERE updated_at >= NOW() - INTERVAL '7 days'
        UNION ALL
        SELECT 'Kitchen handoff confirmation', COUNT(*) FILTER (WHERE status = 'preparing') FROM orders WHERE updated_at >= NOW() - INTERVAL '24 hours'
      ) flows
      ORDER BY flow_volume DESC, flow_name ASC
    `);

    const staffedLines = toNumber(summary?.staffed_lines);
    const activeCalls = toNumber(summary?.active_calls);
    const substitutionCases = toNumber(summary?.substitution_cases);

    const summaryPayload = {
      staffed_lines: staffedLines,
      active_calls: activeCalls,
      substitution_cases: substitutionCases,
      recommended_action: substitutionCases > 0
        ? `Escalate the ${substitutionCases} substitution-sensitive orders before they degrade into cancellations or manual callbacks.`
        : "Phone-ordering load is stable; prioritize tighter kitchen handoff confirmation for new assisted orders.",
    };

    const callFlows = flowRows.rows.map((row) => `${row.flow_name}: ${toNumber(row.flow_volume)} active cases`) || ["No live assisted-ordering flows detected in the current window"];
    const memoryPreview = await getLongCatCustomerMemory({
      customerPhone: "+15550001111",
      customerName: "Repeat caller preview",
      accessibilityFlags: substitutionCases > 0 ? ["voice-confirmation-preferred"] : [],
    });

    return {
      summary: summaryPayload,
      call_flows: callFlows,
      voice_assistant: {
        channel: "phone_ordering",
        live_voice_enabled: true,
        callback_channel: ENV.notificationDispatcherUrl,
        memory_preview: memoryPreview,
      },
      longcat: await buildConsumerAssistant({
        ...summaryPayload,
        call_flows: callFlows,
        memory_summary: memoryPreview.memory_summary,
        live_voice_enabled: true,
      }),
    };
  } catch {
    const summaryPayload = {
      staffed_lines: 7,
      active_calls: 11,
      substitution_cases: 4,
      recommended_action: "Route overflow dinner-period calls to assisted menu capture and auto-escalate unavailable-item decisions to merchant leads.",
    };
    const callFlows = [
      "Assisted order capture with menu confirmation",
      "Stored-customer lookup and saved-payment recovery",
      "Substitution and unavailable-item resolution",
      "Kitchen handoff and fulfillment promise verification",
    ];
    const memoryPreview = await getLongCatCustomerMemory({
      customerPhone: "+15550001111",
      customerName: "Repeat caller preview",
      accessibilityFlags: ["voice-confirmation-preferred"],
    });

    return {
      summary: summaryPayload,
      call_flows: callFlows,
      voice_assistant: {
        channel: "phone_ordering",
        live_voice_enabled: true,
        callback_channel: ENV.notificationDispatcherUrl,
        memory_preview: memoryPreview,
      },
      longcat: await buildConsumerAssistant({
        ...summaryPayload,
        call_flows: callFlows,
        memory_summary: memoryPreview.memory_summary,
        live_voice_enabled: true,
      }),
    };
  }
}
