/**
 * Unilag campus pilot seed (P5-PILOT consumer-parity wave).
 *
 * Seeds a self-contained pilot cohort for the University of Lagos (Akoka)
 * campus launch:
 *   - 3 Lagos operations.service_zone rows (tenant 'switchos-core'):
 *     UNILAG-CAMPUS, AKOKA, YABA with real campus-area boundaries;
 *   - service verticals food-delivery / grocery / pharmacy (slug-upsert);
 *   - 10 merchants (service_providers) across the three verticals;
 *   - 20 couriers (drivers);
 *   - 50 consumers (users) with pre-provisioned referral codes;
 *   - 3 healthcare + 3 freight business_travel_accounts;
 *   - 1 starter referral campaign (marketing_campaigns), 3 referral
 *     incentive rewards (loyalty_rewards) and the current-month referral
 *     leaderboard period (referral_leaderboard_periods).
 *
 * IDEMPOTENT: every statement uses stable pilot ids / natural unique keys
 * with ON CONFLICT ... DO UPDATE/DO NOTHING, and sequences are re-based with
 * setval afterwards (scripts/init-local-postgres.sql convention). Re-running
 * the script converges to the same state and never duplicates rows.
 *
 * ENV GATE: execution requires PILOT_SEED=1 (refuses otherwise). DATABASE_URL
 * must point at the target database via the existing server/db getPool()
 * module. `--dry-run` prints the full plan WITHOUT touching the database and
 * does not require the gate.
 *
 * Usage:
 *   PILOT_SEED=1 DATABASE_URL=... npx tsx scripts/seed/pilot_unilag.ts
 *   npx tsx scripts/seed/pilot_unilag.ts --dry-run
 */

type Statement = { label: string; text: string; values?: unknown[] };

const DRY_RUN = process.argv.includes("--dry-run");
const GATE_ENABLED = process.env.PILOT_SEED === "1";

/** Stable pilot id ranges, far above the dev-bootstrap seed ids (1-8). */
const IDS = {
  merchantBase: 9001, // 9001..9010
  courierBase: 9101, // 9101..9120
  consumerBase: 9201, // 9201..9250
  travelAccountBase: 9301, // 9301..9306
  campaignId: 9401,
  rewardBase: 9501, // 9501..9503
};

const PILOT_TENANT = "switchos-core";
const PILOT_DOMAIN = "unilag.pilot.switchos.ng";

const ZONES: Array<{ code: string; name: string; polygon: [number, number][] }> = [
  {
    code: "UNILAG-CAMPUS",
    name: "Unilag Campus (Akoka)",
    polygon: [
      [3.3855, 6.5125],
      [3.4055, 6.5125],
      [3.4055, 6.5245],
      [3.3855, 6.5245],
    ],
  },
  {
    code: "AKOKA",
    name: "Akoka / Bariga Approach",
    polygon: [
      [3.383, 6.5245],
      [3.407, 6.5245],
      [3.407, 6.536],
      [3.383, 6.536],
    ],
  },
  {
    code: "YABA",
    name: "Yaba / Jibowu",
    polygon: [
      [3.365, 6.5],
      [3.3855, 6.5],
      [3.3855, 6.5245],
      [3.365, 6.5245],
    ],
  },
];

const VERTICALS: Array<{ slug: string; name: string; description: string }> = [
  { slug: "food-delivery", name: "Food Delivery", description: "Campus restaurants and food vendors" },
  { slug: "grocery", name: "Grocery", description: "Campus grocery and essentials stores" },
  { slug: "pharmacy", name: "Pharmacy", description: "Campus pharmacies and health stores" },
];

const MERCHANTS: Array<{ name: string; vertical: string; category: string }> = [
  { name: "Mama Put Campus Kitchen", vertical: "food-delivery", category: "restaurant" },
  { name: "Lagoon View Suya Spot", vertical: "food-delivery", category: "restaurant" },
  { name: "Senate Building Cafeteria", vertical: "food-delivery", category: "restaurant" },
  { name: "Education Complex Shawarma", vertical: "food-delivery", category: "restaurant" },
  { name: "Unilag Mart", vertical: "grocery", category: "grocery" },
  { name: "Akoka Fresh Provisions", vertical: "grocery", category: "grocery" },
  { name: "Campus Essentials Store", vertical: "grocery", category: "grocery" },
  { name: "MedPlus Unilag Pharmacy", vertical: "pharmacy", category: "pharmacy" },
  { name: "Lagoon Health Pharmacy", vertical: "pharmacy", category: "pharmacy" },
  { name: "Student Wellness Pharmacy", vertical: "pharmacy", category: "pharmacy" },
];

const TRAVEL_ACCOUNTS: Array<{ name: string; mix: string; approval: string }> = [
  { name: "Unilag Medical Centre", mix: "healthcare transport", approval: "care-coordinator" },
  { name: "LUTH Campus Shuttle Desk", mix: "healthcare transport", approval: "care-coordinator" },
  { name: "Akoka Community Clinic", mix: "healthcare transport", approval: "care-coordinator" },
  { name: "Campus Press Logistics", mix: "freight & cargo", approval: "manager-review" },
  { name: "Unilag Bookshop Freight", mix: "freight & cargo", approval: "manager-review" },
  { name: "Yaba Market Consolidators", mix: "freight & cargo", approval: "manager-review" },
];

const REFERRAL_REWARDS: Array<{
  name: string;
  description: string;
  cost: number;
  type: string;
  value: string;
  minTier: string;
}> = [
  {
    name: "Campus Free Delivery",
    description: "Free delivery on any campus-zone order",
    cost: 250,
    type: "voucher",
    value: "Free delivery",
    minTier: "bronze",
  },
  {
    name: "Referral Booster ₦1,000",
    description: "₦1,000 voucher for completing 3 successful referrals",
    cost: 800,
    type: "voucher",
    value: "₦1,000 voucher",
    minTier: "bronze",
  },
  {
    name: "Squad Leader Priority Pass",
    description: "Priority dispatch for leaderboard top-20 referrers",
    cost: 1500,
    type: "priority",
    value: "Priority dispatch",
    minTier: "silver",
  },
];

const pad = (value: number, width: number) => String(value).padStart(width, "0");

function buildStatements(): Statement[] {
  const statements: Statement[] = [];

  const verticalInsert = `INSERT INTO service_verticals (name, slug, description, is_active)
           VALUES ($1, $2, $3, true)
           ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, is_active = true`;
  for (const vertical of VERTICALS) {
    statements.push({
      label: `vertical ${vertical.slug}`,
      text: verticalInsert,
      values: [vertical.name, vertical.slug, vertical.description],
    });
  }

  for (const zone of ZONES) {
    const ring = [...zone.polygon, zone.polygon[0]];
    const geojson = JSON.stringify({ type: "Polygon", coordinates: [ring] });
    statements.push({
      label: `operations.service_zone ${zone.code}`,
      text: `INSERT INTO operations.service_zone
             (tenant_id, code, display_name, boundary, metadata)
             VALUES ($1, $2, $3, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))::geography, $5::jsonb)
             ON CONFLICT (tenant_id, code) DO UPDATE
               SET display_name = EXCLUDED.display_name,
                   boundary = EXCLUDED.boundary,
                   metadata = EXCLUDED.metadata,
                   updated_at = NOW()`,
      values: [
        PILOT_TENANT,
        zone.code,
        zone.name,
        geojson,
        JSON.stringify({ pilot: "unilag", city: "lagos" }),
      ],
    });
  }

  MERCHANTS.forEach((merchant, index) => {
    const id = IDS.merchantBase + index;
    statements.push({
      label: `merchant ${merchant.name}`,
      text: `INSERT INTO service_providers
             (id, vertical_id, name, business_name, email, phone, status, verification_status, rating, commission_rate, category, completed_services)
             VALUES ($1,
                     (SELECT id FROM service_verticals WHERE slug = $2),
                     $3, $3, $4, $5,
                     'active', 'verified', '4.5', '15', $6, 0)
             ON CONFLICT (id) DO UPDATE
               SET name = EXCLUDED.name,
                   business_name = EXCLUDED.business_name,
                   status = EXCLUDED.status,
                   verification_status = EXCLUDED.verification_status,
                   category = EXCLUDED.category`,
      values: [
        id,
        merchant.vertical,
        merchant.name,
        `pilot-merchant-${pad(index + 1, 2)}@${PILOT_DOMAIN}`,
        `+23480100${pad(index + 1, 5)}`,
        merchant.category,
      ],
    });
  });
  statements.push({
    label: "re-base service_providers sequence",
    text: `SELECT setval(pg_get_serial_sequence('service_providers', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM service_providers), 1), true)`,
  });

  for (let index = 0; index < 20; index += 1) {
    const n = index + 1;
    const id = IDS.courierBase + index;
    statements.push({
      label: `courier pilot-unilag-courier-${pad(n, 2)}`,
      text: `INSERT INTO drivers
             (id, open_id, name, email, phone, status, vehicle_type, rating, total_orders, acceptance_rate, completion_rate, availability, primary_vertical_id, active_orders, completed_deliveries)
             VALUES ($1, $2, $3, $4, $5, 'online', $6, '4.8', 0, 90, 95, 'available',
                     (SELECT id FROM service_verticals WHERE slug = 'food-delivery'), 0, 0)
             ON CONFLICT (open_id) DO UPDATE
               SET name = EXCLUDED.name, status = EXCLUDED.status, availability = EXCLUDED.availability`,
      values: [
        id,
        `pilot-unilag-courier-${pad(n, 2)}`,
        `Pilot Courier ${pad(n, 2)}`,
        `pilot-courier-${pad(n, 2)}@${PILOT_DOMAIN}`,
        `+23480200${pad(n, 5)}`,
        n % 3 === 0 ? "car" : "bike",
      ],
    });
  }
  statements.push({
    label: "re-base drivers sequence",
    text: `SELECT setval(pg_get_serial_sequence('drivers', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM drivers), 1), true)`,
  });

  for (let index = 0; index < 50; index += 1) {
    const n = index + 1;
    const id = IDS.consumerBase + index;
    statements.push({
      label: `consumer pilot-unilag-consumer-${pad(n, 3)}`,
      text: `INSERT INTO users (id, open_id, name, email, phone, role, referral_code)
             VALUES ($1, $2, $3, $4, $5, 'user', $6)
             ON CONFLICT (open_id) DO UPDATE
               SET name = EXCLUDED.name,
                   referral_code = COALESCE(users.referral_code, EXCLUDED.referral_code)`,
      values: [
        id,
        `pilot-unilag-consumer-${pad(n, 3)}`,
        `Pilot Consumer ${pad(n, 3)}`,
        `pilot-consumer-${pad(n, 3)}@${PILOT_DOMAIN}`,
        `+23480300${pad(n, 5)}`,
        `UNILAG${pad(n, 3)}`,
      ],
    });
  }
  statements.push({
    label: "re-base users sequence",
    text: `SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM users), 1), true)`,
  });

  TRAVEL_ACCOUNTS.forEach((account, index) => {
    const id = IDS.travelAccountBase + index;
    statements.push({
      label: `business account ${account.name}`,
      text: `INSERT INTO business_travel_accounts
             (id, company_name, billing_email, status, approval_mode, service_mix)
             VALUES ($1, $2, $3, 'active', $4, $5)
             ON CONFLICT (id) DO UPDATE
               SET company_name = EXCLUDED.company_name,
                   approval_mode = EXCLUDED.approval_mode,
                   service_mix = EXCLUDED.service_mix,
                   updated_at = NOW()`,
      values: [
        id,
        account.name,
        `billing-${pad(index + 1, 2)}@${PILOT_DOMAIN}`,
        account.approval,
        account.mix,
      ],
    });
  });
  statements.push({
    label: "re-base business_travel_accounts sequence",
    text: `SELECT setval(pg_get_serial_sequence('business_travel_accounts', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM business_travel_accounts), 1), true)`,
  });

  statements.push({
    label: "starter referral campaign",
    text: `INSERT INTO marketing_campaigns
           (id, campaign_name, campaign_type, sms_template, target_audience, status, is_active, channel, starts_at, ends_at)
           VALUES ($1, 'Unilag Campus Launch', 'referral', $2, 'all', 'active', true, 'whatsapp', NOW() - INTERVAL '1 day', NOW() + INTERVAL '60 days')
           ON CONFLICT (id) DO UPDATE
             SET campaign_name = EXCLUDED.campaign_name,
                 status = EXCLUDED.status,
                 is_active = EXCLUDED.is_active,
                 ends_at = EXCLUDED.ends_at,
                 updated_at = NOW()`,
    values: [
      IDS.campaignId,
      "Join SwitchOS at Unilag! Use my referral code {{referral_code}} for 200 bonus points.",
    ],
  });
  statements.push({
    label: "re-base marketing_campaigns sequence",
    text: `SELECT setval(pg_get_serial_sequence('marketing_campaigns', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM marketing_campaigns), 1), true)`,
  });

  REFERRAL_REWARDS.forEach((reward, index) => {
    const id = IDS.rewardBase + index;
    statements.push({
      label: `referral incentive ${reward.name}`,
      text: `INSERT INTO loyalty_rewards
             (id, reward_name, description, points_cost, points_required, reward_type, reward_value, min_tier, is_active, status, expires_at)
             VALUES ($1, $2, $3, $4, $4, $5, $6, $7, true, 'active', NOW() + INTERVAL '90 days')
             ON CONFLICT (id) DO UPDATE
               SET reward_name = EXCLUDED.reward_name,
                   description = EXCLUDED.description,
                   points_cost = EXCLUDED.points_cost,
                   points_required = EXCLUDED.points_required,
                   is_active = EXCLUDED.is_active,
                   status = EXCLUDED.status,
                   expires_at = EXCLUDED.expires_at`,
      values: [id, reward.name, reward.description, reward.cost, reward.type, reward.value, reward.minTier],
    });
  });
  statements.push({
    label: "re-base loyalty_rewards sequence",
    text: `SELECT setval(pg_get_serial_sequence('loyalty_rewards', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM loyalty_rewards), 1), true)`,
  });

  statements.push({
    label: "current-month referral leaderboard period",
    text: `INSERT INTO referral_leaderboard_periods (period_name, period_start, period_end, is_active)
           VALUES (TO_CHAR(DATE_TRUNC('month', NOW()), 'YYYY-MM'),
                   DATE_TRUNC('month', NOW()),
                   DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 second',
                   true)
           ON CONFLICT (period_name) DO NOTHING`,
  });
  statements.push({
    label: "re-base referral_leaderboard_periods sequence",
    text: `SELECT setval(pg_get_serial_sequence('referral_leaderboard_periods', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM referral_leaderboard_periods), 1), true)`,
  });

  return statements;
}

async function main() {
  const statements = buildStatements();

  if (DRY_RUN) {
    console.log(`[pilot-unilag] DRY RUN — ${statements.length} statements planned, no writes.`);
    for (const statement of statements) {
      console.log(`\n-- ${statement.label}`);
      console.log(statement.text);
      if (statement.values) console.log(`-- values: ${JSON.stringify(statement.values)}`);
    }
    return;
  }

  if (!GATE_ENABLED) {
    console.error(
      "[pilot-unilag] refused: set PILOT_SEED=1 to execute the pilot seed (or pass --dry-run to preview).",
    );
    process.exit(1);
  }

  // Imported lazily so --dry-run never opens a database connection.
  const { getPool } = await import("../../server/db");
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of statements) {
      await client.query(statement.text, (statement.values ?? []) as never[]);
      console.log(`[pilot-unilag] ok: ${statement.label}`);
    }
    await client.query("COMMIT");
    console.log(`[pilot-unilag] seed complete: ${statements.length} statements applied (idempotent).`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("[pilot-unilag] seed failed, rolled back:", error);
    process.exit(1);
  } finally {
    client.release();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
