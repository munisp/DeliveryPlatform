import { getPool } from "../db";

/**
 * Real pool-backed query layer for the mobility surfaces (migration 0073).
 *
 * These functions replace the fail-closed summaries in server/db.ts
 * (mobility_overview / rider_app / driver_mobility_summary / business_travel /
 * freight / healthcare_transport). Return shapes mirror those summaries, but
 * every value is computed from live tables: rider_trips,
 * business_travel_accounts, business_travel_trips, freight_loads,
 * healthcare_transport_bookings (0073) plus users, drivers, orders,
 * service_providers, membership_plans, referral_codes, support_tickets,
 * payout_settlements, and mobility.match_attempt / mobility.service_category.
 *
 * Values with no live source are returned as 0/null — never padded.
 */

const ACTIVE_TRIP_STATUSES = ["requested", "assigned", "in_progress"];
const ACTIVE_DISPATCH_STATES = [
  "requested",
  "matching",
  "driver_offered",
  "driver_reserved",
  "driver_en_route",
  "driver_arrived",
  "pickup_verified",
  "in_progress",
  "completed_pending_payment",
];

type QueryRows = { rows: any[] };

function toNumber(value: unknown, digits = 2): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

function toCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

async function queryRows(sql: string, params: unknown[] = []): Promise<any[]> {
  try {
    const pool = await getPool();
    const result: QueryRows = await pool.query(sql, params);
    return result.rows;
  } catch {
    return [];
  }
}

async function countOf(sql: string, params: unknown[] = []): Promise<number> {
  const rows = await queryRows(sql, params);
  return toCount(rows[0]?.c);
}

export type MobilityOverviewSummary = {
  summary: {
    active_trips: number;
    active_drivers: number;
    active_providers: number;
    airport_ready_zones: number;
    multimodal_modes: number;
    business_accounts: number;
    recommended_action: string;
  };
  live_trips: Array<{
    id: number;
    trip_type: string;
    status: string;
    fare: number;
    eta_minutes: number | null;
    modality: string;
    created_at: string;
  }>;
  mobility_supply: Array<{
    id: number;
    name: string;
    status: string;
    vehicle_class: string | null;
    acceptance_rate: number;
    completion_rate: number;
    airport_certified: boolean;
  }>;
  service_modes: string[];
};

export async function getMobilityOverviewSummary(
  limit = 8,
): Promise<MobilityOverviewSummary> {
  const [tripRows, driverRows, activeTrips, activeDispatchTrips, activeDrivers, activeProviders, airportZones, modesInUse, businessAccounts] =
    await Promise.all([
      queryRows(
        `SELECT id, trip_type, status, fare_minor, modality, created_at,
                CASE
                  WHEN completed_at IS NOT NULL AND assigned_at IS NOT NULL
                    THEN ROUND(EXTRACT(EPOCH FROM (completed_at - assigned_at)) / 60)::int
                  WHEN status IN ('requested', 'assigned', 'in_progress')
                    THEN ROUND(EXTRACT(EPOCH FROM (now() - requested_at)) / 60)::int
                  ELSE NULL
                END AS eta_minutes
         FROM rider_trips
         ORDER BY created_at DESC NULLS LAST
         LIMIT $1`,
        [limit],
      ),
      queryRows(
        `SELECT d.id, d.name, d.status, d.vehicle_type, d.acceptance_rate, d.completion_rate,
                EXISTS (
                  SELECT 1
                  FROM mobility.driver_service_category dsc
                  JOIN mobility.service_category sc ON sc.id = dsc.service_category_id
                  JOIN users u ON u.id = dsc.driver_user_id
                  WHERE u.open_id = d.open_id AND sc.code ILIKE '%airport%'
                ) AS airport_certified
         FROM drivers d
         ORDER BY d.updated_at DESC NULLS LAST, d.created_at DESC NULLS LAST
         LIMIT $1`,
        [limit],
      ),
      countOf(
        `SELECT COUNT(*)::int AS c FROM rider_trips WHERE status = ANY($1::text[])`,
        [ACTIVE_TRIP_STATUSES],
      ),
      countOf(
        `SELECT COUNT(*)::int AS c FROM mobility.ride_trip WHERE state = ANY($1::text[])`,
        [ACTIVE_DISPATCH_STATES],
      ),
      countOf(
        `SELECT COUNT(*)::int AS c FROM drivers WHERE lower(status) IN ('active', 'online', 'available')`,
      ),
      countOf(
        `SELECT COUNT(*)::int AS c FROM service_providers WHERE lower(status) = 'active'`,
      ),
      countOf(
        `SELECT COUNT(DISTINCT zone_id)::int AS c FROM mobility.service_category
         WHERE code ILIKE '%airport%' AND state = 'active'`,
      ),
      countOf(`SELECT COUNT(DISTINCT modality)::int AS c FROM rider_trips`),
      countOf(
        `SELECT COUNT(*)::int AS c FROM business_travel_accounts WHERE status <> 'closed'`,
      ),
    ]);

  return {
    summary: {
      active_trips: activeTrips + activeDispatchTrips,
      active_drivers: activeDrivers,
      active_providers: activeProviders,
      airport_ready_zones: airportZones,
      multimodal_modes: modesInUse,
      business_accounts: businessAccounts,
      recommended_action:
        "Coordinate ride, courier, airport, and enterprise mobility programs from one dispatch layer with live pricing, support, and service recovery orchestration.",
    },
    live_trips: tripRows.map((row) => ({
      id: toCount(row.id),
      trip_type: String(row.trip_type ?? "standard"),
      status: String(row.status ?? "requested"),
      fare: toNumber(Number(row.fare_minor ?? 0) / 100),
      eta_minutes:
        row.eta_minutes === null || row.eta_minutes === undefined
          ? null
          : toCount(row.eta_minutes),
      modality: String(row.modality ?? "car"),
      created_at: row.created_at,
    })),
    mobility_supply: driverRows.map((row) => ({
      id: toCount(row.id),
      name: String(row.name ?? ""),
      status: String(row.status ?? "offline"),
      vehicle_class: row.vehicle_type === null ? null : String(row.vehicle_type),
      acceptance_rate: toNumber(row.acceptance_rate, 1),
      completion_rate: toNumber(row.completion_rate, 1),
      airport_certified: Boolean(row.airport_certified),
    })),
    service_modes: [
      "Rideshare",
      "Courier",
      "Airport transfers",
      "Business transport",
      "Healthcare transportation",
      "Transit connections",
    ],
  };
}

export type RiderAppSummary = {
  summary: {
    saved_places: number;
    active_promotions: number;
    membership_benefits: number;
    support_threads: number;
    recommended_next_step: string;
  };
  booking_modes: Array<{ key: string; label: string; eta_minutes: number | null }>;
  recent_activity: Array<{
    id: number;
    status: string;
    address: string | null;
    amount: number;
    experience_type: string;
    created_at: string;
  }>;
  suggested_destinations: Array<{
    id: number;
    label: string;
    category: string | null;
    rating: number;
  }>;
};

export async function getRiderAppSummary(limit = 6): Promise<RiderAppSummary> {
  const [savedPlaces, activePromotions, membershipBenefits, supportThreads, etaRows, deliveryEtaRow, activityRows, destinationRows] =
    await Promise.all([
      countOf(
        `SELECT COUNT(DISTINCT dropoff_label)::int AS c FROM rider_trips
         WHERE dropoff_label IS NOT NULL AND length(trim(dropoff_label)) > 0`,
      ),
      countOf(
        `SELECT COUNT(*)::int AS c FROM referral_codes
         WHERE is_active AND (expires_at IS NULL OR expires_at > now())`,
      ),
      countOf(
        `SELECT COALESCE(SUM(jsonb_array_length(perks)), 0)::int AS c FROM membership_plans WHERE is_active`,
      ),
      countOf(
        `SELECT COUNT(*)::int AS c FROM support_tickets WHERE status IN ('open', 'in_progress')`,
      ),
      queryRows(
        `SELECT trip_type, ROUND(AVG(EXTRACT(EPOCH FROM (assigned_at - requested_at)) / 60))::int AS eta
         FROM rider_trips
         WHERE assigned_at IS NOT NULL AND requested_at IS NOT NULL
         GROUP BY trip_type`,
      ),
      queryRows(
        `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (actual_pickup_time - created_at)) / 60))::int AS eta
         FROM orders WHERE actual_pickup_time IS NOT NULL`,
      ),
      queryRows(
        `SELECT id, status, address, amount, experience_type, created_at FROM (
           SELECT id, status, dropoff_label AS address, fare_minor / 100.0 AS amount,
                  'mobility' AS experience_type, created_at
           FROM rider_trips
           UNION ALL
           SELECT id, status::text, delivery_address AS address,
                  CASE WHEN total_amount ~ '^[0-9]+(\\.[0-9]+)?$' THEN total_amount::numeric ELSE 0 END AS amount,
                  'delivery' AS experience_type, created_at
           FROM orders
         ) combined
         ORDER BY created_at DESC NULLS LAST
         LIMIT $1`,
        [limit],
      ),
      queryRows(
        `SELECT id, business_name, category, rating
         FROM service_providers
         ORDER BY CASE WHEN rating ~ '^[0-9]+(\\.[0-9]+)?$' THEN rating::numeric END DESC NULLS LAST,
                  business_name ASC
         LIMIT $1`,
        [limit],
      ),
    ]);

  const etaByType = new Map<string, number>(
    etaRows.map((row) => [String(row.trip_type), toCount(row.eta)]),
  );
  const deliveryEta =
    deliveryEtaRow[0]?.eta === null || deliveryEtaRow[0]?.eta === undefined
      ? null
      : toCount(deliveryEtaRow[0].eta);

  return {
    summary: {
      saved_places: savedPlaces,
      active_promotions: activePromotions,
      membership_benefits: membershipBenefits,
      support_threads: supportThreads,
      recommended_next_step:
        "Unify ride booking, delivery ordering, loyalty, and support recovery in one rider-facing experience.",
    },
    booking_modes: [
      { key: "rideshare", label: "Book a ride", eta_minutes: etaByType.get("standard") ?? null },
      { key: "delivery", label: "Order delivery", eta_minutes: deliveryEta },
      { key: "airport", label: "Reserve airport pickup", eta_minutes: etaByType.get("airport") ?? null },
      { key: "healthcare", label: "Schedule a care trip", eta_minutes: etaByType.get("healthcare") ?? null },
      { key: "business", label: "Request business travel", eta_minutes: etaByType.get("business") ?? null },
      { key: "transit", label: "Plan transit connection", eta_minutes: null },
    ],
    recent_activity: activityRows.map((row) => ({
      id: toCount(row.id),
      status: String(row.status ?? ""),
      address: row.address === null ? null : String(row.address),
      amount: toNumber(row.amount),
      experience_type: String(row.experience_type ?? "mobility"),
      created_at: row.created_at,
    })),
    suggested_destinations: destinationRows.map((row) => ({
      id: toCount(row.id),
      label: String(row.business_name ?? ""),
      category: row.category === null ? null : String(row.category),
      rating: toNumber(row.rating, 1),
    })),
  };
}

export type DriverMobilitySummary = {
  summary: {
    online_drivers: number;
    trip_radar_candidates: number;
    airport_ready_drivers: number;
    avg_weekly_earnings: number;
    recommended_action: string;
  };
  supply_queue: Array<{
    id: number;
    name: string;
    status: string;
    mobility_mode: string | null;
    rating: number;
    acceptance_rate: number;
    completion_rate: number;
    earnings_today: number;
  }>;
  earning_streams: string[];
};

export async function getDriverMobilitySummary(
  limit = 8,
): Promise<DriverMobilitySummary> {
  const [driverRows, onlineDrivers, radarCandidates, airportDrivers, weeklyRows] =
    await Promise.all([
      queryRows(
        `SELECT d.id, d.name, d.status, d.rating, d.acceptance_rate, d.completion_rate,
                (SELECT sc.code
                 FROM mobility.driver_service_category dsc
                 JOIN mobility.service_category sc ON sc.id = dsc.service_category_id
                 JOIN users u ON u.id = dsc.driver_user_id
                 WHERE u.open_id = d.open_id
                 ORDER BY dsc.created_at DESC
                 LIMIT 1) AS mobility_mode,
                (SELECT COALESCE(SUM(ps.total_amount), 0)
                 FROM payout_settlements ps
                 WHERE ps.driver_id = d.id AND ps.created_at::date = current_date) AS earnings_today
         FROM drivers d
         ORDER BY d.updated_at DESC NULLS LAST, d.created_at DESC NULLS LAST
         LIMIT $1`,
        [limit],
      ),
      countOf(
        `SELECT COUNT(*)::int AS c FROM drivers WHERE lower(status) IN ('active', 'online', 'available')`,
      ),
      countOf(
        `SELECT COUNT(*)::int AS c FROM mobility.match_attempt WHERE state IN ('open', 'offering')`,
      ),
      countOf(
        `SELECT COUNT(DISTINCT dsc.driver_user_id)::int AS c
         FROM mobility.driver_service_category dsc
         JOIN mobility.service_category sc ON sc.id = dsc.service_category_id
         WHERE sc.code ILIKE '%airport%'`,
      ),
      queryRows(
        `SELECT COALESCE(ROUND(AVG(total), 2), 0) AS v FROM (
           SELECT SUM(total_amount) AS total
           FROM payout_settlements
           WHERE period_end >= now() - interval '7 days'
           GROUP BY driver_id
         ) weekly`,
      ),
    ]);

  return {
    summary: {
      online_drivers: onlineDrivers,
      trip_radar_candidates: radarCandidates,
      airport_ready_drivers: airportDrivers,
      avg_weekly_earnings: toNumber(weeklyRows[0]?.v),
      recommended_action:
        "Blend passenger trips, courier trips, airport runs, and scheduled healthcare work into one driver earnings stack.",
    },
    supply_queue: driverRows.map((row) => ({
      id: toCount(row.id),
      name: String(row.name ?? ""),
      status: String(row.status ?? "offline"),
      mobility_mode: row.mobility_mode === null ? null : String(row.mobility_mode),
      rating: toNumber(row.rating),
      acceptance_rate: toNumber(row.acceptance_rate, 1),
      completion_rate: toNumber(row.completion_rate, 1),
      earnings_today: toNumber(row.earnings_today),
    })),
    earning_streams: [
      "Passenger rides",
      "Food and retail delivery",
      "Airport transfers",
      "Healthcare transport",
      "Business travel",
      "Large-item assisted delivery",
    ],
  };
}

export type BusinessTravelSummary = {
  summary: {
    enterprise_accounts: number;
    active_travelers: number;
    open_expense_items: number;
    policy_templates: number;
    recommended_action: string;
  };
  travel_programs: Array<{
    id: number;
    name: string;
    approval_mode: string;
    service_mix: string;
  }>;
  travelers: Array<{
    id: number;
    name: string | null;
    email: string | null;
    role: string;
    spend_ytd: number;
    compliance_state: string;
  }>;
  policy_templates: string[];
};

const TRAVEL_POLICY_TEMPLATES = [
  "Airport and executive ride class caps",
  "Meals and delivery spend thresholds",
  "Scheduled healthcare and guest travel approvals",
  "Cost-center routing and expensing rules",
];

export async function getBusinessTravelSummary(
  limit = 8,
): Promise<BusinessTravelSummary> {
  const [enterpriseAccounts, activeTravelers, openExpenseItems, programRows, travelerRows] =
    await Promise.all([
      countOf(
        `SELECT COUNT(*)::int AS c FROM business_travel_accounts WHERE status = 'active'`,
      ),
      countOf(
        `SELECT COUNT(DISTINCT traveler_user_id)::int AS c FROM business_travel_trips
         WHERE status NOT IN ('cancelled', 'rejected')
           AND requested_at >= now() - interval '90 days'`,
      ),
      countOf(
        `SELECT COUNT(*)::int AS c FROM business_travel_trips WHERE expense_state = 'open'`,
      ),
      queryRows(
        `SELECT id, company_name, approval_mode, service_mix
         FROM business_travel_accounts
         ORDER BY created_at ASC NULLS LAST
         LIMIT $1`,
        [limit],
      ),
      queryRows(
        `SELECT u.id, u.name, u.email, u.role::text AS role,
                COALESCE(SUM(t.fare_minor) FILTER (
                  WHERE t.requested_at >= date_trunc('year', now())
                ), 0) / 100.0 AS spend_ytd,
                CASE
                  WHEN COUNT(*) FILTER (WHERE t.expense_state = 'open') > 0 THEN 'review'
                  ELSE 'in_policy'
                END AS compliance_state
         FROM business_travel_trips t
         JOIN users u ON u.id = t.traveler_user_id
         GROUP BY u.id, u.name, u.email, u.role
         ORDER BY spend_ytd DESC
         LIMIT $1`,
        [limit],
      ),
    ]);

  return {
    summary: {
      enterprise_accounts: enterpriseAccounts,
      active_travelers: activeTravelers,
      open_expense_items: openExpenseItems,
      policy_templates: TRAVEL_POLICY_TEMPLATES.length,
      recommended_action:
        "Consolidate employee rides, meals, guest trips, airport transfers, and policy controls under one enterprise travel program.",
    },
    travel_programs: programRows.map((row) => ({
      id: toCount(row.id),
      name: String(row.company_name ?? ""),
      approval_mode: String(row.approval_mode ?? "manager-review"),
      service_mix: String(row.service_mix ?? ""),
    })),
    travelers: travelerRows.map((row) => ({
      id: toCount(row.id),
      name: row.name === null ? null : String(row.name),
      email: row.email === null ? null : String(row.email),
      role: String(row.role ?? "user"),
      spend_ytd: toNumber(row.spend_ytd),
      compliance_state: String(row.compliance_state ?? "in_policy"),
    })),
    policy_templates: TRAVEL_POLICY_TEMPLATES,
  };
}

export type FreightSummary = {
  summary: {
    shipper_accounts: number;
    carrier_lanes: number;
    active_loads: number;
    procurement_events: number;
    recommended_action: string;
  };
  load_board: Array<{
    id: number;
    lane: string;
    status: string;
    value: number;
    equipment: string;
    address: string | null;
  }>;
  carrier_network: Array<{
    id: number;
    name: string;
    category: string | null;
    status: string;
    verification_status: string;
    compliance_score: number | null;
  }>;
};

export async function getFreightSummary(limit = 8): Promise<FreightSummary> {
  const [shipperAccounts, carrierLanes, activeLoads, procurementEvents, loadRows, carrierRows] =
    await Promise.all([
      countOf(
        `SELECT COUNT(DISTINCT shipper_provider_id)::int AS c FROM freight_loads
         WHERE shipper_provider_id IS NOT NULL`,
      ),
      countOf(
        `SELECT COUNT(DISTINCT lane_code)::int AS c FROM freight_loads
         WHERE lane_code IS NOT NULL AND length(trim(lane_code)) > 0`,
      ),
      countOf(
        `SELECT COUNT(*)::int AS c FROM freight_loads WHERE status IN ('assigned', 'picked_up', 'in_transit')`,
      ),
      countOf(
        `SELECT COUNT(*)::int AS c FROM freight_loads WHERE status IN ('draft', 'tendered')`,
      ),
      queryRows(
        `SELECT id, status, value_minor, equipment, lane_code, origin_label, destination_label
         FROM freight_loads
         ORDER BY created_at DESC NULLS LAST
         LIMIT $1`,
        [limit],
      ),
      queryRows(
        `SELECT DISTINCT sp.id, sp.business_name, sp.category, sp.status, sp.verification_status
         FROM service_providers sp
         WHERE sp.id IN (SELECT shipper_provider_id FROM freight_loads WHERE shipper_provider_id IS NOT NULL)
            OR lower(sp.category) LIKE '%freight%'
            OR lower(sp.category) LIKE '%logistics%'
            OR lower(sp.category) LIKE '%carrier%'
         ORDER BY sp.business_name ASC
         LIMIT $1`,
        [limit],
      ),
    ]);

  return {
    summary: {
      shipper_accounts: shipperAccounts,
      carrier_lanes: carrierLanes,
      active_loads: activeLoads,
      procurement_events: procurementEvents,
      recommended_action:
        "Coordinate shippers, carriers, lane pricing, appointment windows, and exception handling from one freight control tower.",
    },
    load_board: loadRows.map((row) => ({
      id: toCount(row.id),
      lane:
        row.lane_code && String(row.lane_code).trim().length > 0
          ? String(row.lane_code)
          : [row.origin_label, row.destination_label]
              .filter((part) => part && String(part).trim().length > 0)
              .join(" → ") || `Load ${toCount(row.id)}`,
      status: String(row.status ?? "draft"),
      value: toNumber(Number(row.value_minor ?? 0) / 100),
      equipment: String(row.equipment ?? "box_truck"),
      address: row.destination_label === null ? null : String(row.destination_label),
    })),
    carrier_network: carrierRows.map((row) => ({
      id: toCount(row.id),
      name: String(row.business_name ?? ""),
      category: row.category === null ? null : String(row.category),
      status: String(row.status ?? "pending"),
      verification_status: String(row.verification_status ?? "pending"),
      // No carrier compliance scoring backend exists yet; the page says so.
      compliance_score: null,
    })),
  };
}

export type HealthcareTransportSummary = {
  summary: {
    care_programs: number;
    scheduled_trips: number;
    compliant_providers: number;
    compliance_packs: number;
    recommended_action: string;
  };
  transport_programs: Array<{
    id: number;
    name: string;
    schedule_mode: string;
    compliance: string | null;
  }>;
  active_cases: Array<{
    id: number;
    status: string;
    service_line: string;
    eta_minutes: number | null;
    created_at: string;
  }>;
  compliance_packs: string[];
};

const HEALTHCARE_COMPLIANCE_PACKS = [
  "Patient identity verification",
  "HIPAA-sensitive notes",
  "Chain of custody",
  "Prescription handoff validation",
];

export async function getHealthcareTransportSummary(
  limit = 8,
): Promise<HealthcareTransportSummary> {
  const [carePrograms, scheduledTrips, compliantProviders, programRows, caseRows] =
    await Promise.all([
      countOf(
        `SELECT COUNT(DISTINCT program)::int AS c FROM healthcare_transport_bookings`,
      ),
      countOf(
        `SELECT COUNT(*)::int AS c FROM healthcare_transport_bookings
         WHERE status = 'scheduled' AND (appointment_at IS NULL OR appointment_at >= now())`,
      ),
      countOf(
        `SELECT COUNT(*)::int AS c FROM service_providers
         WHERE lower(verification_status) = 'verified'
           AND (lower(category) LIKE '%health%' OR lower(category) LIKE '%care%' OR lower(category) LIKE '%pharm%')`,
      ),
      queryRows(
        `SELECT MIN(id)::int AS id, program, schedule_mode,
                NULLIF(trim(string_agg(DISTINCT compliance_notes, ' · ')), '') AS compliance
         FROM healthcare_transport_bookings
         GROUP BY program, schedule_mode
         ORDER BY program ASC
         LIMIT $1`,
        [limit],
      ),
      queryRows(
        `SELECT id, status, service_line, appointment_at, created_at,
                CASE
                  WHEN appointment_at IS NOT NULL
                    THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (appointment_at - now())) / 60))::int
                  ELSE NULL
                END AS eta_minutes
         FROM healthcare_transport_bookings
         WHERE status IN ('scheduled', 'en_route', 'arrived')
         ORDER BY appointment_at ASC NULLS LAST, created_at DESC NULLS LAST
         LIMIT $1`,
        [limit],
      ),
    ]);

  return {
    summary: {
      care_programs: carePrograms,
      scheduled_trips: scheduledTrips,
      compliant_providers: compliantProviders,
      compliance_packs: HEALTHCARE_COMPLIANCE_PACKS.length,
      recommended_action:
        "Use scheduled pickups, patient eligibility checks, and chain-of-custody controls for care transportation and regulated delivery.",
    },
    transport_programs: programRows.map((row) => ({
      id: toCount(row.id),
      name: String(row.program ?? ""),
      schedule_mode: String(row.schedule_mode ?? "scheduled"),
      compliance: row.compliance === null ? null : String(row.compliance),
    })),
    active_cases: caseRows.map((row) => ({
      id: toCount(row.id),
      status: String(row.status ?? "scheduled"),
      service_line: String(row.service_line ?? "patient_trip"),
      eta_minutes:
        row.eta_minutes === null || row.eta_minutes === undefined
          ? null
          : toCount(row.eta_minutes),
      created_at: row.created_at,
    })),
    compliance_packs: HEALTHCARE_COMPLIANCE_PACKS,
  };
}
