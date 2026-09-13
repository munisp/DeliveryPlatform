import { getPool } from "../db";

/**
 * Workspace truthfulness queries (migration 0075).
 *
 * These replace the hard-coded "not configured" workspace responses for
 * tableside ordering and white-label apps. Every number is computed from the
 * 0075 operational tables (plus service_providers); an empty deployment
 * honestly reports zero counts with guidance in `recommended_action`.
 */

export type TablesideWorkspaceShape = {
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

export type WhiteLabelAppsWorkspaceShape = {
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

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

type TablesideSummaryRow = {
  total_venues: number | string;
  qr_venues: number | string;
  pay_at_table_venues: number | string;
  active_sessions: number | string;
  upsell_modules: number | string;
};

type TablesideVenueRow = {
  id: number;
  name: string;
  qr_enabled: boolean;
  pay_at_table_enabled: boolean;
  upsell_modules: unknown;
  status: string;
  provider_name: string | null;
  provider_status: string | null;
  rating: string | null;
  open_sessions: number | string;
};

type WhiteLabelSummaryRow = {
  branded_apps_live: number | string;
  templates_available: number | string;
  push_channels_ready: number | string;
  release_tracks: number | string;
};

type WhiteLabelTemplateRow = {
  name: string;
  audience: string;
  release_track: string;
};

type WhiteLabelBrandRow = {
  id: number;
  app_name: string;
  bundle_id: string;
  template: string;
  status: string;
  release_track: string;
  launched_at: Date | string | null;
  provider_id: number;
  brand: string | null;
  provider_status: string | null;
};

export async function getRealTablesideWorkspace(): Promise<TablesideWorkspaceShape> {
  const pool = await getPool();

  const [summaryResult, venueResult] = await Promise.all([
    pool.query<TablesideSummaryRow>(`
      SELECT
        COUNT(v.id) AS total_venues,
        COUNT(v.id) FILTER (WHERE v.qr_enabled) AS qr_venues,
        COUNT(v.id) FILTER (WHERE v.pay_at_table_enabled) AS pay_at_table_venues,
        (SELECT COUNT(s.id) FROM public.tableside_sessions s WHERE s.closed_at IS NULL AND s.status = 'open') AS active_sessions,
        (
          SELECT COUNT(DISTINCT module)
          FROM public.tableside_venues uv
          CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(uv.upsell_modules) = 'array' THEN uv.upsell_modules ELSE '[]'::jsonb END
          ) AS module
        ) AS upsell_modules
      FROM public.tableside_venues v
    `),
    pool.query<TablesideVenueRow>(`
      SELECT
        v.id,
        v.name,
        v.qr_enabled,
        v.pay_at_table_enabled,
        v.upsell_modules,
        v.status,
        sp.business_name AS provider_name,
        sp.status AS provider_status,
        sp.rating,
        COUNT(s.id) FILTER (WHERE s.closed_at IS NULL AND s.status = 'open') AS open_sessions
      FROM public.tableside_venues v
      LEFT JOIN public.service_providers sp ON sp.id = v.provider_id
      LEFT JOIN public.tableside_sessions s ON s.venue_id = v.id
      GROUP BY v.id, sp.business_name, sp.status, sp.rating
      ORDER BY open_sessions DESC, v.id ASC
      LIMIT 24
    `),
  ]);

  const summary = summaryResult.rows[0];
  const totalVenues = toNumber(summary?.total_venues);
  const qrVenues = toNumber(summary?.qr_venues);
  const payAtTableVenues = toNumber(summary?.pay_at_table_venues);
  const activeSessions = toNumber(summary?.active_sessions);
  const upsellModules = toNumber(summary?.upsell_modules);
  const payAtTableEnablement = totalVenues > 0
    ? Math.round((payAtTableVenues / totalVenues) * 100)
    : 0;

  const orderModes: string[] = [];
  if (qrVenues > 0) orderModes.push("Scan to order");
  if (payAtTableVenues > 0) orderModes.push("Pay at table");
  if (activeSessions > 0) orderModes.push("Live table service");
  if (totalVenues > qrVenues) orderModes.push("Server assist");

  let recommendedAction: string;
  if (totalVenues === 0) {
    recommendedAction = "No tableside venues are registered yet; onboard a provider venue into tableside_venues to activate QR ordering.";
  } else if (qrVenues === 0) {
    recommendedAction = `${totalVenues} venue(s) are registered but none have QR enabled; enable QR menus to activate scan-to-order.`;
  } else if (payAtTableVenues < qrVenues) {
    recommendedAction = `${qrVenues - payAtTableVenues} QR-enabled venue(s) lack pay-at-table; enable table-side payment to complete the dine-in flow.`;
  } else {
    recommendedAction = "All QR venues support pay-at-table; monitor active sessions for adoption and upsell performance.";
  }

  return {
    summary: {
      qr_venues: qrVenues,
      active_sessions: activeSessions,
      pay_at_table_enablement: payAtTableEnablement,
      upsell_modules: upsellModules,
      recommended_action: recommendedAction,
    },
    order_modes: orderModes,
    venue_rollout: venueResult.rows.map((row) => ({
      id: Number(row.id),
      venue: row.name,
      provider: row.provider_name,
      provider_status: row.provider_status,
      qr_enabled: row.qr_enabled === true,
      pay_at_table_enabled: row.pay_at_table_enabled === true,
      upsell_modules: Array.isArray(row.upsell_modules) ? row.upsell_modules.length : 0,
      open_sessions: toNumber(row.open_sessions),
      status: row.status,
      rating: row.rating == null ? null : toNumber(row.rating),
    })),
  };
}

export async function getRealWhiteLabelAppsWorkspace(): Promise<WhiteLabelAppsWorkspaceShape> {
  const pool = await getPool();

  const [summaryResult, templateResult, brandResult] = await Promise.all([
    pool.query<WhiteLabelSummaryRow>(`
      SELECT
        COUNT(a.id) FILTER (WHERE a.status IN ('live', 'launched') OR a.launched_at IS NOT NULL) AS branded_apps_live,
        COUNT(DISTINCT a.template) AS templates_available,
        COUNT(DISTINCT a.push_channel) FILTER (WHERE a.push_channel IS NOT NULL AND a.push_channel <> '') AS push_channels_ready,
        COUNT(DISTINCT a.release_track) AS release_tracks
      FROM public.white_label_apps a
    `),
    pool.query<WhiteLabelTemplateRow>(`
      SELECT DISTINCT
        a.template AS name,
        a.audience,
        a.release_track
      FROM public.white_label_apps a
      ORDER BY a.template ASC, a.audience ASC, a.release_track ASC
      LIMIT 24
    `),
    pool.query<WhiteLabelBrandRow>(`
      SELECT
        a.id,
        a.app_name,
        a.bundle_id,
        a.template,
        a.status,
        a.release_track,
        a.launched_at,
        a.provider_id,
        sp.business_name AS brand,
        sp.status AS provider_status
      FROM public.white_label_apps a
      LEFT JOIN public.service_providers sp ON sp.id = a.provider_id
      ORDER BY a.launched_at DESC NULLS LAST, a.id ASC
      LIMIT 24
    `),
  ]);

  const summary = summaryResult.rows[0];
  const brandedAppsLive = toNumber(summary?.branded_apps_live);
  const templatesAvailable = toNumber(summary?.templates_available);
  const pushChannelsReady = toNumber(summary?.push_channels_ready);
  const releaseTracks = toNumber(summary?.release_tracks);
  const registeredApps = brandResult.rows.length;

  let recommendedAction: string;
  if (registeredApps === 0) {
    recommendedAction = "No white-label apps are registered yet; create a tenant app record in white_label_apps to begin a branded launch.";
  } else if (brandedAppsLive === 0) {
    recommendedAction = `${registeredApps} app(s) are registered but none are live; move a candidate through its release track to launch.`;
  } else if (pushChannelsReady === 0) {
    recommendedAction = "Live apps have no push channel configured; wire a messaging channel before driving launch operations.";
  } else {
    recommendedAction = "Branded apps are live with push channels wired; govern rollouts through the observed release tracks.";
  }

  return {
    summary: {
      branded_apps_live: brandedAppsLive,
      templates_available: templatesAvailable,
      push_channels_ready: pushChannelsReady,
      release_tracks: releaseTracks,
      recommended_action: recommendedAction,
    },
    app_templates: templateResult.rows.map((row) => ({
      name: row.name,
      audience: row.audience,
      release_track: row.release_track,
    })),
    brands: brandResult.rows.map((row) => ({
      id: Number(row.id),
      brand: row.brand,
      provider_id: Number(row.provider_id),
      provider_status: row.provider_status,
      app_name: row.app_name,
      bundle_id: row.bundle_id,
      template: row.template,
      status: row.status,
      release_track: row.release_track,
      launched_at: row.launched_at == null ? null : new Date(row.launched_at).toISOString(),
    })),
  };
}
