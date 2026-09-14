import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

import { buildConsumerAssistant, buildDispatchIntelligence, buildMerchantConsultant } from "../_core/longcat";
import { ENV } from "../_core/env";
import { getRealTablesideWorkspace, getRealWhiteLabelAppsWorkspace } from "../_core/workspaceTruthfulness";

const { Pool } = pg;
const merchantBenchmarkSnapshotPath = path.resolve(process.cwd(), "validation", "longcat_merchant_benchmarks.json");
let pool: pg.Pool | null = null;

export class WorkspaceDataUnavailableError extends Error {
  readonly workspace: string;

  constructor(workspace: string, cause?: unknown) {
    super(`${workspace.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_DATA_UNAVAILABLE`);
    this.name = "WorkspaceDataUnavailableError";
    this.workspace = workspace;
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

type TablesideWorkspace = {
  summary: {
    qr_venues: number;
    active_sessions: number;
    pay_at_table_enablement: number;
    upsell_modules: number;
    recommended_action: string;
  };
  order_modes: string[];
  venue_rollout: Array<Record<string, unknown>>;
};

type WhiteLabelAppsWorkspace = {
  summary: {
    branded_apps_live: number;
    templates_available: number;
    push_channels_ready: number;
    release_tracks: number;
    recommended_action: string;
  };
  app_templates: Array<{ name: string; audience: string; release_track: string }>;
  brands: Array<Record<string, unknown>>;
};

// TLS verification is always on for database connections. The only way to
// disable it is the development-only DATABASE_TLS_SKIP_VERIFY flag, which
// env.ts refuses to honor in production.
function buildDatabaseSsl(useSsl: boolean) {
  if (!useSsl) return false;
  if (ENV.databaseTlsSkipVerify) {
    console.warn(
      "[SECURITY] DATABASE_TLS_SKIP_VERIFY=true: TLS certificate verification is DISABLED for the platform workspaces database connection. This is a development-only override and is rejected in production.",
    );
    return { rejectUnauthorized: false as const };
  }
  return {
    rejectUnauthorized: true as const,
    ...(ENV.databaseSslCa ? { ca: ENV.databaseSslCa } : {}),
  };
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      ssl: buildDatabaseSsl(ENV.databaseUrl.includes("sslmode=require")),
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

function unavailable(workspace: string, error: unknown): never {
  console.warn(`[SwitchOS] ${workspace} data is unavailable`, error);
  throw new WorkspaceDataUnavailableError(workspace, error);
}

async function readMerchantBenchmarkSnapshot() {
  try {
    const raw = await fs.readFile(merchantBenchmarkSnapshotPath, "utf8");
    const parsed = JSON.parse(raw) as {
      generated_at?: string;
      benchmarks?: Array<{
        domain?: string;
        label?: string;
        visits_total_latest?: number | null;
        bounce_rate_latest?: number | null;
        global_rank_latest?: number | null;
      }>;
    };

    return {
      available: true,
      reason: null,
      generated_at: parsed.generated_at ?? null,
      benchmarks: (parsed.benchmarks ?? []).map((entry) => ({
        label: entry.label ?? entry.domain ?? "unknown",
        domain: entry.domain ?? "unknown",
        visits_total_latest: toNumber(entry.visits_total_latest),
        bounce_rate_latest: entry.bounce_rate_latest == null ? null : toNumber(entry.bounce_rate_latest),
        global_rank_latest: entry.global_rank_latest == null ? null : toNumber(entry.global_rank_latest),
      })),
    };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : "merchant_benchmark_snapshot_unavailable",
      generated_at: null,
      benchmarks: [] as Array<{ label: string; domain: string; visits_total_latest: number; bounce_rate_latest: number | null; global_rank_latest: number | null }>,
    };
  }
}

export async function getDriverMobilityWorkspace(limit = 8) {
  try {
    const [summary, driverRows, hotspotRows] = await Promise.all([
      queryOne<{
        total_drivers: number | string;
        online_drivers: number | string;
        busy_drivers: number | string;
        offline_drivers: number | string;
        active_orders: number | string;
        pending_orders: number | string;
        avg_queue_minutes: number | string;
      }>(`
        SELECT
          (SELECT COUNT(*) FROM drivers) AS total_drivers,
          (SELECT COUNT(*) FROM drivers WHERE status IN ('online', 'available')) AS online_drivers,
          (SELECT COUNT(*) FROM drivers WHERE status = 'busy') AS busy_drivers,
          (SELECT COUNT(*) FROM drivers WHERE status = 'offline') AS offline_drivers,
          (SELECT COUNT(*) FROM orders WHERE status IN ('confirmed', 'assigned', 'in_progress')) AS active_orders,
          (SELECT COUNT(*) FROM orders WHERE status = 'pending') AS pending_orders,
          (SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0) FILTER (WHERE status = 'pending'), 0) FROM orders WHERE created_at >= NOW() - INTERVAL '24 hours') AS avg_queue_minutes
      `),
      getPool().query<{
        id: number;
        name: string;
        status: string;
        rating: number | string | null;
        primary_vertical_id: number | string | null;
      }>(`
        SELECT id, name, status, rating, primary_vertical_id
        FROM drivers
        ORDER BY updated_at DESC NULLS LAST, id DESC
        LIMIT $1
      `, [limit]),
      getPool().query<{
        zone_key: number | string;
        open_orders: number | string;
        waiting_orders: number | string;
        available_drivers: number | string;
        avg_wait_minutes: number | string;
      }>(`
        WITH order_pressure AS (
          SELECT COALESCE(vertical_id, 0) AS zone_key,
                 COUNT(*) FILTER (WHERE status IN ('pending', 'confirmed', 'assigned', 'in_progress')) AS open_orders,
                 COUNT(*) FILTER (WHERE status = 'pending') AS waiting_orders,
                 AVG(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0) FILTER (WHERE status = 'pending') AS avg_wait_minutes
          FROM orders
          WHERE created_at >= NOW() - INTERVAL '24 hours'
          GROUP BY COALESCE(vertical_id, 0)
        ), driver_supply AS (
          SELECT COALESCE(primary_vertical_id, 0) AS zone_key,
                 COUNT(*) FILTER (WHERE status IN ('online', 'available')) AS available_drivers
          FROM drivers
          GROUP BY COALESCE(primary_vertical_id, 0)
        )
        SELECT COALESCE(op.zone_key, ds.zone_key) AS zone_key,
               COALESCE(op.open_orders, 0) AS open_orders,
               COALESCE(op.waiting_orders, 0) AS waiting_orders,
               COALESCE(ds.available_drivers, 0) AS available_drivers,
               COALESCE(op.avg_wait_minutes, 0) AS avg_wait_minutes
        FROM order_pressure op
        FULL OUTER JOIN driver_supply ds ON ds.zone_key = op.zone_key
        ORDER BY (COALESCE(op.open_orders, 0)::numeric / GREATEST(COALESCE(ds.available_drivers, 0), 1)) DESC
        LIMIT 3
      `),
    ]);

    if (!summary) {
      return unavailable("driver_mobility", new Error("driver mobility summary query returned no result"));
    }
    const driverSummary = summary;
    const activeOrders = toNumber(driverSummary.active_orders);
    const onlineDrivers = toNumber(driverSummary.online_drivers);
    const pendingOrders = toNumber(driverSummary.pending_orders);
    const telemetrySignals = hotspotRows.rows.map((row) => {
      const openOrders = toNumber(row.open_orders);
      const availableDrivers = toNumber(row.available_drivers);
      const pressure = openOrders / Math.max(availableDrivers, 1);
      return `vertical ${toNumber(row.zone_key)}=${pressure.toFixed(2)} pressure, ${toNumber(row.waiting_orders)} waiting orders, ${availableDrivers} available drivers`;
    });

    const summaryPayload = {
      total_drivers: toNumber(driverSummary.total_drivers),
      online_drivers: onlineDrivers,
      busy_drivers: toNumber(driverSummary.busy_drivers),
      offline_drivers: toNumber(driverSummary.offline_drivers),
      active_orders: activeOrders,
      pending_orders: pendingOrders,
      avg_queue_minutes: Number(toNumber(driverSummary.avg_queue_minutes).toFixed(2)),
      recommended_action: pendingOrders > onlineDrivers
        ? "Pending demand exceeds visible supply; review dispatch capacity before accepting more work."
        : "Supply and queue indicators are within the currently observed database state.",
    };

    return {
      source: "postgres",
      generated_at: new Date().toISOString(),
      summary: summaryPayload,
      supply_queue: driverRows.rows.map((driver) => ({
        driver_id: Number(driver.id),
        driver: driver.name,
        vertical_id: driver.primary_vertical_id == null ? null : toNumber(driver.primary_vertical_id),
        status: driver.status,
        rating: driver.rating == null ? null : toNumber(driver.rating),
        reliability: null,
        weekly_earnings: null,
        next_action: driver.status === "busy"
          ? "Currently assigned; do not treat as available supply."
          : "No synthetic performance recommendation is provided without a real score record.",
      })),
      telemetry: {
        summary: `Observed ${pendingOrders} pending orders, ${activeOrders} active orders, and ${onlineDrivers} available or online drivers from PostgreSQL.`,
        signals: telemetrySignals,
        hotspots: hotspotRows.rows.map((row) => ({
          zone_key: toNumber(row.zone_key),
          open_orders: toNumber(row.open_orders),
          waiting_orders: toNumber(row.waiting_orders),
          available_drivers: toNumber(row.available_drivers),
          avg_wait_minutes: Number(toNumber(row.avg_wait_minutes).toFixed(2)),
        })),
      },
      longcat: await buildDispatchIntelligence({
        ...summaryPayload,
        trip_radar_candidates: null,
        airport_ready_drivers: null,
        avg_weekly_earnings: null,
        telemetry_summary: `Observed ${pendingOrders} pending orders and ${onlineDrivers} available or online drivers.`,
        telemetry_signals: telemetrySignals,
        supply_queue: [],
      }),
    };
  } catch (error) {
    return unavailable("driver_mobility", error);
  }
}

export async function getTablesideWorkspace(): Promise<TablesideWorkspace> {
  try {
    return await getRealTablesideWorkspace();
  } catch (error) {
    return unavailable("tableside_ordering", error);
  }
}

export async function getWhiteLabelAppsWorkspace(): Promise<WhiteLabelAppsWorkspace> {
  try {
    return await getRealWhiteLabelAppsWorkspace();
  } catch (error) {
    return unavailable("white_label_apps", error);
  }
}

export async function getMerchantChannelWorkspace() {
  const externalBenchmarks = await readMerchantBenchmarkSnapshot();

  try {
    const [summary, channelRows] = await Promise.all([
      queryOne<{
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
      `),
      getPool().query<{ channel: string }>(`
        SELECT DISTINCT channel
        FROM marketing_campaigns
        WHERE channel IS NOT NULL AND channel <> ''
        ORDER BY channel ASC
        LIMIT 8
      `),
    ]);

    const activatedChannels = toNumber(summary?.activated_channels);
    const brandedStorefronts = toNumber(summary?.branded_storefronts);
    const partnerChannels = toNumber(summary?.partner_channels);
    const recentPushDeliveries = toNumber(summary?.recent_push_deliveries);
    const campaignsRunning = toNumber(summary?.campaigns_running);
    const ownedShare = activatedChannels > 0 ? ((Math.max(activatedChannels - partnerChannels, 0) / activatedChannels) * 100) : 0;
    const channelVelocity = activatedChannels > 0 ? recentPushDeliveries / activatedChannels : 0;
    const channelMix = channelRows.rows.map((row) => `${row.channel} channel with ${recentPushDeliveries} push deliveries observed in the last 7 days`);
    const benchmarkSummary = externalBenchmarks.available
      ? `External benchmark snapshot loaded with ${externalBenchmarks.benchmarks.length} domains.`
      : `External benchmark snapshot unavailable: ${externalBenchmarks.reason}`;
    const summaryPayload = {
      activated_channels: activatedChannels,
      branded_storefronts: brandedStorefronts,
      partner_channels: partnerChannels,
      recommended_action: campaignsRunning > 0
        ? `Stabilize ${campaignsRunning} live campaign channels before opening additional storefront surfaces.`
        : "No live campaign workload is present in the queried operational data.",
    };

    return {
      source: "postgres",
      generated_at: new Date().toISOString(),
      summary: summaryPayload,
      channel_mix: channelMix,
      benchmarks: {
        availability: externalBenchmarks.available ? "available" : "unavailable",
        reason: externalBenchmarks.reason,
        owned_share_percent: Number(ownedShare.toFixed(1)),
        push_deliveries_per_channel: Number(channelVelocity.toFixed(1)),
        live_campaigns: campaignsRunning,
        benchmark_summary: benchmarkSummary,
        generated_at: externalBenchmarks.generated_at,
        external_domains: externalBenchmarks.benchmarks,
      },
      longcat: await buildMerchantConsultant({
        ...summaryPayload,
        channel_mix: channelMix,
        benchmark_summary: benchmarkSummary,
        forecast_inputs: [
          `${activatedChannels} active channel surfaces`,
          `${brandedStorefronts} branded storefronts`,
          `${recentPushDeliveries} recent push deliveries`,
        ],
      }),
    };
  } catch (error) {
    return unavailable("merchant_channels", error);
  }
}

export async function getServiceRecoveryWorkspace() {
  try {
    const [summary, queueRows] = await Promise.all([
      queryOne<{
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
      `),
      getPool().query<{ queue_name: string; queue_size: number | string }>(`
        SELECT queue_name, queue_size
        FROM (
          SELECT 'Pending order follow-up' AS queue_name, COUNT(*) FILTER (WHERE status = 'pending') AS queue_size FROM orders WHERE updated_at >= NOW() - INTERVAL '7 days'
          UNION ALL
          SELECT 'Cancelled order compensation', COUNT(*) FILTER (WHERE status = 'cancelled') FROM orders WHERE updated_at >= NOW() - INTERVAL '7 days'
          UNION ALL
          SELECT 'Payment exception review', COUNT(*) FILTER (WHERE status NOT IN ('completed', 'settled')) FROM transactions WHERE updated_at >= NOW() - INTERVAL '7 days'
        ) queues
        ORDER BY queue_size DESC, queue_name ASC
      `),
    ]);

    const openIncidents = toNumber(summary?.open_incidents);
    const compensationPending = toNumber(summary?.compensation_pending);
    const recoveredOrders = toNumber(summary?.recovered_orders);
    const totalProblemOrders = toNumber(summary?.total_problem_orders);
    const saveRate = totalProblemOrders > 0 ? Math.round((recoveredOrders / totalProblemOrders) * 100) : null;

    return {
      source: "postgres",
      generated_at: new Date().toISOString(),
      summary: {
        open_incidents: openIncidents,
        compensation_pending: compensationPending,
        save_rate: saveRate,
        recommended_action: compensationPending > 0
          ? `Work the ${compensationPending} cancelled-order compensation cases before they age into settlement backlog.`
          : "No compensation backlog is present in the queried recovery window.",
      },
      queues: queueRows.rows.map((row) => `${row.queue_name}: ${toNumber(row.queue_size)} cases`),
    };
  } catch (error) {
    return unavailable("service_recovery", error);
  }
}

export async function getPhoneOrderingWorkspace() {
  try {
    const [summary, flowRows] = await Promise.all([
      queryOne<{
        staffed_lines: number | string;
        active_calls: number | string;
        substitution_cases: number | string;
      }>(`
        SELECT
          COUNT(DISTINCT sp.id) AS staffed_lines,
          COUNT(*) FILTER (WHERE status IN ('pending', 'accepted')) AS active_calls,
          COUNT(*) FILTER (WHERE notes ILIKE '%substitut%' OR notes ILIKE '%unavailable%' OR notes ILIKE '%call%') AS substitution_cases
        FROM service_providers sp
        LEFT JOIN orders o ON o.provider_id = sp.id AND o.updated_at >= NOW() - INTERVAL '24 hours'
        WHERE COALESCE(sp.status, 'inactive') = 'active'
      `),
      getPool().query<{ flow_name: string; flow_volume: number | string }>(`
        SELECT flow_name, flow_volume
        FROM (
          SELECT 'Assisted order capture' AS flow_name, COUNT(*) FILTER (WHERE status IN ('pending', 'accepted')) AS flow_volume FROM orders WHERE updated_at >= NOW() - INTERVAL '24 hours'
          UNION ALL
          SELECT 'Substitution handling', COUNT(*) FILTER (WHERE notes ILIKE '%substitut%' OR notes ILIKE '%unavailable%') FROM orders WHERE updated_at >= NOW() - INTERVAL '7 days'
          UNION ALL
          SELECT 'Kitchen handoff confirmation', COUNT(*) FILTER (WHERE status = 'preparing') FROM orders WHERE updated_at >= NOW() - INTERVAL '24 hours'
        ) flows
        ORDER BY flow_volume DESC, flow_name ASC
      `),
    ]);

    const staffedLines = toNumber(summary?.staffed_lines);
    const activeCalls = toNumber(summary?.active_calls);
    const substitutionCases = toNumber(summary?.substitution_cases);
    const callFlows = flowRows.rows.map((row) => `${row.flow_name}: ${toNumber(row.flow_volume)} active cases`);
    const voiceGatewayConfigured = Boolean(ENV.longcatVoiceGatewayUrl?.trim());
    const summaryPayload = {
      staffed_lines: staffedLines,
      active_calls: activeCalls,
      substitution_cases: substitutionCases,
      recommended_action: substitutionCases > 0
        ? `Review the ${substitutionCases} substitution-sensitive orders before they degrade into cancellations or callbacks.`
        : "No substitution-sensitive workload is present in the queried operational data.",
    };

    return {
      source: "postgres",
      generated_at: new Date().toISOString(),
      summary: summaryPayload,
      call_flows: callFlows,
      voice_assistant: {
        channel: "phone_ordering",
        gateway_configured: voiceGatewayConfigured,
        availability: "not_verified_by_workspace_query",
        callback_channel: ENV.notificationDispatcherUrl || null,
        memory_preview: null,
        memory_status: "requires_actual_caller_context",
      },
      messaging_assistant: {
        channels: ["sms_ordering", "sms_follow_up"],
        dispatcher_url: ENV.notificationDispatcherUrl || null,
      },
      longcat: await buildConsumerAssistant({
        ...summaryPayload,
        call_flows: callFlows,
        memory_summary: "No active caller context was supplied to this workspace query.",
        live_voice_enabled: voiceGatewayConfigured,
        messaging_channels: ["sms_ordering", "sms_follow_up"],
      }),
    };
  } catch (error) {
    return unavailable("phone_ordering", error);
  }
}
