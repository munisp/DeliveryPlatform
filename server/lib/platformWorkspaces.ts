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

export function getDriverMobilityWorkspace(limit = 8) {
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

  return {
    summary: {
      online_drivers: drivers.filter((driver) => driver.online).length,
      trip_radar_candidates: drivers.filter((driver) => driver.tripRadarEligible).length,
      airport_ready_drivers: drivers.filter((driver) => driver.airportReady).length,
      avg_weekly_earnings: Math.round(drivers.reduce((sum, driver) => sum + driver.weeklyEarnings, 0) / drivers.length),
      recommended_action: "Airport demand is outrunning reserve supply; rebalance one delivery-first cohort toward transfer readiness.",
    },
    earning_streams: [
      "Airport reserve queue incentives",
      "Trip radar surge offers for mixed mobility and courier work",
      "Healthcare transport premiums for trained drivers",
      "High-reliability weekly guarantee programs",
    ],
    supply_queue: supplyQueue,
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

export function getMerchantChannelWorkspace() {
  return {
    summary: {
      activated_channels: 5,
      branded_storefronts: 12,
      partner_channels: 3,
      recommended_action: "Focus the next release on merchant activation sequencing instead of adding more disconnected storefront CRUD.",
    },
    channel_mix: [
      "Owned web storefronts",
      "Branded mobile ordering",
      "Tableside ordering",
      "Phone-assisted capture",
      "Partner marketplace syndication",
    ],
  };
}

export function getServiceRecoveryWorkspace() {
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

export function getPhoneOrderingWorkspace() {
  return {
    summary: {
      staffed_lines: 7,
      active_calls: 11,
      substitution_cases: 4,
      recommended_action: "Route overflow dinner-period calls to assisted menu capture and auto-escalate unavailable-item decisions to merchant leads.",
    },
    call_flows: [
      "Assisted order capture with menu confirmation",
      "Stored-customer lookup and saved-payment recovery",
      "Substitution and unavailable-item resolution",
      "Kitchen handoff and fulfillment promise verification",
    ],
  };
}
