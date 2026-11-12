import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { getPool } from "../db";
import {
  operatorMutationProcedure,
  router,
  workspaceReadProcedure,
} from "./trpc";
import { resolvePublicUser } from "./publicUsers";
import { IDEMPOTENCY_KEY_REGEX } from "./merchantSelfServe";
import {
  getVerticalComplianceSummary,
  listCompliancePacks,
  type ComplianceAgeRestriction,
  type ComplianceDocumentRequirement,
  type ComplianceHandlingRequirement,
} from "./compliancePacks";

/**
 * WS-COMPLIANCE (P4-C) write layer for public.vertical_compliance_packs
 * (drizzle/0076_vertical_compliance_packs.sql — NO new migration; the table,
 * UNIQUE(vertical_slug, jurisdiction), and jsonb descriptor CHECKs already
 * exist).
 *
 *  - upsertCompliancePack: operatorMutationProcedure("operate"); INSERT ...
 *    ON CONFLICT (vertical_slug, jurisdiction) DO UPDATE against the real
 *    0076 constraint. required_documents / handling_requirements are zod
 *    descriptor arrays (never prose-only) so the 0076 jsonb_typeof CHECKs
 *    can never be violated by well-formed input; any DB-side CHECK breach
 *    (23514) still maps to CONFLICT per the program error convention.
 *  - deactivateCompliancePack: soft-delete (active=false) keyed by
 *    (vertical_slug, jurisdiction); unknown pack → NOT_FOUND.
 *  - seedDefaultCompliancePacks: idempotent upsert of the freight /
 *    business-travel / courier packs with Nigeria-first jurisdiction content
 *    (NG federal baseline + NG-LA Lagos State per vertical). Running twice is
 *    a no-op: the ON CONFLICT path rewrites identical content, so pack count
 *    and the uncovered_verticals gap detector are stable across runs.
 *
 * Idempotency (program rule 4): every writer takes idempotencyKey matching
 * IDEMPOTENCY_KEY_REGEX (merchantSelfServe.ts:68-70) and replays through the
 * public.consumer_processed_events ledger (0072) with consumer_name
 * 'compliance-packs'; event_id is `${actorUserId}:${key}` so keys are
 * actor-scoped. Exact replay returns the stored result untouched.
 *
 * PostgreSQL errcode mapping follows the merchantSelfServe convention:
 * 23505/23514 → CONFLICT, 22023 → BAD_REQUEST, P0002 → NOT_FOUND.
 */

const LEDGER_CONSUMER = "compliance-packs";
const UPSERT_TOPIC = "pack-upsert";
const DEACTIVATE_TOPIC = "pack-deactivate";
const SEED_TOPIC = "pack-seed";

const idempotencyKeySchema = z.string().regex(IDEMPOTENCY_KEY_REGEX);

// Descriptor schemas mirror the 0076 CHECK-comment shapes exactly; the jsonb
// columns are arrays of typed descriptors, never free prose.
const documentRequirementSchema = z.object({
  code: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(255),
  issuer: z.string().trim().min(1).max(255),
  verification: z.string().trim().min(1).max(255),
  renewal: z.string().trim().min(1).max(100),
  retention_days: z.number().int().nonnegative(),
});

const handlingRequirementSchema = z.object({
  code: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(255),
  enforcement: z.string().trim().min(1).max(255),
  parameters: z.record(z.string(), z.unknown()),
});

const ageRestrictionSchema = z.object({
  minimum_age: z.number().int().min(0).max(120),
  verification: z.string().trim().min(1).max(255),
  scope: z.string().trim().min(1).max(100),
  jurisdictional_basis: z.string().trim().min(1).max(500),
});

const verticalSlugSchema = z.string().trim().min(1).max(100);
const jurisdictionSchema = z.string().trim().min(1).max(160);

export const upsertCompliancePackInputSchema = z.object({
  verticalSlug: verticalSlugSchema,
  jurisdiction: jurisdictionSchema,
  requiredDocuments: z.array(documentRequirementSchema).max(100),
  ageRestriction: ageRestrictionSchema.nullable().optional(),
  handlingRequirements: z.array(handlingRequirementSchema).max(100),
  active: z.boolean().optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const deactivateCompliancePackInputSchema = z.object({
  verticalSlug: verticalSlugSchema,
  jurisdiction: jurisdictionSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const seedDefaultCompliancePacksInputSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
});

export type UpsertCompliancePackInput = z.infer<
  typeof upsertCompliancePackInputSchema
>;

export type CompliancePackMutationResult = {
  packId: number;
  verticalSlug: string;
  jurisdiction: string;
  active: boolean;
  created: boolean;
  replayed: boolean;
};

export type SeedDefaultCompliancePacksResult = {
  verticals: string[];
  jurisdictions: string[];
  packsTouched: number;
  inserted: number;
  updated: number;
  replayed: boolean;
};

type Queryable = {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
};

function mapPackSqlError(error: unknown): never {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "23505" || code === "23514") {
    // UNIQUE race or jsonb CHECK breach — conflict per program convention.
    throw new TRPCError({
      code: "CONFLICT",
      message: `COMPLIANCE_PACK_CONFLICT:${message}`,
      cause: error,
    });
  }
  if (code === "22023") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `COMPLIANCE_PACK_INVALID:${message}`,
      cause: error,
    });
  }
  if (code === "P0002") {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `COMPLIANCE_PACK_NOT_FOUND:${message}`,
      cause: error,
    });
  }
  throw error;
}

async function readLedger<T>(
  db: Queryable,
  topic: string,
  eventId: string,
): Promise<T | null> {
  const stored = await db.query(
    `SELECT result_json FROM public.consumer_processed_events
     WHERE consumer_name = $1 AND topic = $2 AND event_id = $3`,
    [LEDGER_CONSUMER, topic, eventId],
  );
  const result = stored.rows[0]?.result_json;
  return result == null ? null : (result as T);
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

type PackUpsertCoreInput = {
  verticalSlug: string;
  jurisdiction: string;
  requiredDocuments: ComplianceDocumentRequirement[];
  ageRestriction: ComplianceAgeRestriction | null;
  handlingRequirements: ComplianceHandlingRequirement[];
  active: boolean;
};

async function upsertPackRow(
  db: Queryable,
  input: PackUpsertCoreInput,
): Promise<{ packId: number; inserted: boolean }> {
  const result = await db.query(
    `INSERT INTO public.vertical_compliance_packs
       (vertical_id, vertical_slug, jurisdiction, required_documents,
        age_restriction, handling_requirements, active, updated_at)
     VALUES (
       (SELECT v.id FROM public.service_verticals v WHERE v.slug = $1),
       $1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, NOW())
     ON CONFLICT (vertical_slug, jurisdiction) DO UPDATE SET
       vertical_id = EXCLUDED.vertical_id,
       required_documents = EXCLUDED.required_documents,
       age_restriction = EXCLUDED.age_restriction,
       handling_requirements = EXCLUDED.handling_requirements,
       active = EXCLUDED.active,
       updated_at = NOW()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      input.verticalSlug,
      input.jurisdiction,
      JSON.stringify(input.requiredDocuments),
      input.ageRestriction == null
        ? null
        : JSON.stringify(input.ageRestriction),
      JSON.stringify(input.handlingRequirements),
      input.active,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "COMPLIANCE_PACK_UPSERT_RETURNED_NO_ROW",
    });
  }
  return { packId: Number(row.id), inserted: Boolean(row.inserted) };
}

export async function upsertCompliancePackRecord(
  actorUserId: number,
  input: UpsertCompliancePackInput,
): Promise<CompliancePackMutationResult> {
  const pool = await getPool();
  const ledgerId = `${actorUserId}:${input.idempotencyKey}`;
  const stored = await readLedger<CompliancePackMutationResult>(
    pool,
    UPSERT_TOPIC,
    ledgerId,
  );
  if (stored && typeof stored.packId === "number") {
    return { ...stored, replayed: true };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('compliance-pack:' || $1::text, 0))`,
      [`${input.verticalSlug}:${input.jurisdiction}`],
    );
    const { packId, inserted } = await upsertPackRow(client, {
      verticalSlug: input.verticalSlug,
      jurisdiction: input.jurisdiction,
      requiredDocuments: input.requiredDocuments,
      ageRestriction: input.ageRestriction ?? null,
      handlingRequirements: input.handlingRequirements,
      active: input.active ?? true,
    });
    const result: CompliancePackMutationResult = {
      packId,
      verticalSlug: input.verticalSlug,
      jurisdiction: input.jurisdiction,
      active: input.active ?? true,
      created: inserted,
      replayed: false,
    };
    await recordLedger(client, UPSERT_TOPIC, ledgerId, {
      packId: result.packId,
      verticalSlug: result.verticalSlug,
      jurisdiction: result.jurisdiction,
      active: result.active,
      created: result.created,
      replayed: false,
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    mapPackSqlError(error);
  } finally {
    client.release();
  }
}

export async function deactivateCompliancePackRecord(
  actorUserId: number,
  input: z.infer<typeof deactivateCompliancePackInputSchema>,
): Promise<CompliancePackMutationResult> {
  const pool = await getPool();
  const ledgerId = `${actorUserId}:${input.idempotencyKey}`;
  const stored = await readLedger<CompliancePackMutationResult>(
    pool,
    DEACTIVATE_TOPIC,
    ledgerId,
  );
  if (stored && typeof stored.packId === "number") {
    return { ...stored, replayed: true };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE public.vertical_compliance_packs
       SET active = false, updated_at = NOW()
       WHERE vertical_slug = $1 AND jurisdiction = $2
       RETURNING id, active`,
      [input.verticalSlug, input.jurisdiction],
    );
    const row = updated.rows[0];
    if (!row) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `COMPLIANCE_PACK_NOT_FOUND:${input.verticalSlug}:${input.jurisdiction}`,
      });
    }
    const result: CompliancePackMutationResult = {
      packId: Number(row.id),
      verticalSlug: input.verticalSlug,
      jurisdiction: input.jurisdiction,
      active: false,
      created: false,
      replayed: false,
    };
    await recordLedger(client, DEACTIVATE_TOPIC, ledgerId, {
      packId: result.packId,
      verticalSlug: result.verticalSlug,
      jurisdiction: result.jurisdiction,
      active: false,
      created: false,
      replayed: false,
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof TRPCError) throw error;
    mapPackSqlError(error);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Default packs: freight / business-travel / courier — Nigeria-first.
// Two jurisdictions per vertical: the NG federal baseline and the Lagos State
// (NG-LA) overlay, matching the LAG-first market rollout. All descriptor
// arrays follow the 0076 shapes so the jsonb CHECKs always hold.
// ---------------------------------------------------------------------------

type DefaultPackSeed = PackUpsertCoreInput;

const NG_FEDERAL = "NG federal baseline";
const NG_LAGOS = "NG-LA Lagos State";

export const DEFAULT_COMPLIANCE_PACK_SEEDS: DefaultPackSeed[] = [
  {
    verticalSlug: "freight",
    jurisdiction: `${NG_FEDERAL} (FRSC road safety + federal haulage rules)`,
    requiredDocuments: [
      {
        code: "haulage_operator_permit",
        label: "Road haulage operator permit",
        issuer: "federal_ministry_of_transport",
        verification: "permit_number_lookup",
        renewal: "annual",
        retention_days: 1825,
      },
      {
        code: "vehicle_roadworthiness",
        label: "Vehicle roadworthiness certificate",
        issuer: "frsc_vehicle_inspection_service",
        verification: "certificate_number_lookup",
        renewal: "annual",
        retention_days: 1095,
      },
      {
        code: "driver_license_class",
        label: "Heavy-duty driver licence (appropriate FRSC class)",
        issuer: "frsc",
        verification: "license_number_lookup",
        renewal: "every_5_years",
        retention_days: 2190,
      },
      {
        code: "goods_in_transit_insurance",
        label: "Goods-in-transit insurance certificate",
        issuer: "naicom_licensed_insurer",
        verification: "policy_number_lookup",
        renewal: "annual",
        retention_days: 2555,
      },
    ],
    ageRestriction: null,
    handlingRequirements: [
      {
        code: "load_manifest",
        label: "Signed load manifest with shipper, consignee, and cargo description",
        enforcement: "manifest_capture_at_pickup",
        parameters: {
          required_fields: ["shipper", "consignee", "cargo_description", "gross_weight_kg"],
        },
      },
      {
        code: "axle_weight_limit",
        label: "Axle and gross weight limits verified before dispatch",
        enforcement: "weighbridge_ticket_at_pickup",
        parameters: { max_gross_weight_kg: 60000, block_overweight: true },
      },
      {
        code: "dangerous_goods_declaration",
        label: "Dangerous goods declared, placarded, and segregated",
        enforcement: "cargo_declaration_check",
        parameters: { requires_dg_declaration: true, mixed_load_dg_prohibited: true },
      },
      {
        code: "proof_of_delivery",
        label: "Signed proof of delivery captured at destination",
        enforcement: "signature_capture_at_dropoff",
        parameters: { allow_unattended_dropoff: false },
      },
    ],
    active: true,
  },
  {
    verticalSlug: "freight",
    jurisdiction: `${NG_LAGOS} (LASTMA / Lagos freight and logistics overlay)`,
    requiredDocuments: [
      {
        code: "lagos_haulage_registration",
        label: "Lagos State haulage operator registration",
        issuer: "lagos_state_ministry_of_transport",
        verification: "registration_number_lookup",
        renewal: "annual",
        retention_days: 1825,
      },
      {
        code: "truck_route_permit",
        label: "Lagos truck route and corridor access permit",
        issuer: "lastma",
        verification: "permit_number_lookup",
        renewal: "annual",
        retention_days: 1095,
      },
    ],
    ageRestriction: null,
    handlingRequirements: [
      {
        code: "restricted_hours_compliance",
        label: "Truck movement restricted to approved hours inside Lagos corridors",
        enforcement: "geofence_and_time_window_check",
        parameters: { check_at: ["dispatch", "pickup", "delivery"] },
      },
      {
        code: "designated_route_adherence",
        label: "Loads follow LASTMA-designated freight routes",
        enforcement: "route_deviation_alert",
        parameters: { alert_on_deviation: true, tolerance_meters: 500 },
      },
    ],
    active: true,
  },
  {
    verticalSlug: "business-travel",
    jurisdiction: `${NG_FEDERAL} (FIRS expense documentation + NCAA travel rules)`,
    requiredDocuments: [
      {
        code: "corporate_travel_policy_ack",
        label: "Employee acknowledgement of the corporate travel policy",
        issuer: "employer_travel_desk",
        verification: "signed_acknowledgement_on_file",
        renewal: "annual",
        retention_days: 2190,
      },
      {
        code: "firs_compliant_receipts",
        label: "FIRS-compliant itemized receipts for reimbursable expenses",
        issuer: "vendor_or_merchant",
        verification: "receipt_capture_with_vat_breakdown",
        renewal: "per_expense",
        retention_days: 2190,
      },
      {
        code: "travel_approval_record",
        label: "Pre-trip approval record from the cost-center owner",
        issuer: "employer_approval_workflow",
        verification: "approval_reference_lookup",
        renewal: "per_trip",
        retention_days: 2190,
      },
    ],
    ageRestriction: null,
    handlingRequirements: [
      {
        code: "pre_trip_approval_gate",
        label: "Trips cannot be submitted without a recorded approval",
        enforcement: "approval_workflow_check",
        parameters: { block_unapproved_submission: true },
      },
      {
        code: "per_diem_cap",
        label: "Per-diem spend capped to the traveler band",
        enforcement: "expense_cap_check",
        parameters: { currency: "NGN", enforce_at: ["submission", "reconciliation"] },
      },
      {
        code: "receipt_retention",
        label: "Receipts retained for the FIRS audit window",
        enforcement: "document_retention_policy",
        parameters: { retention_days: 2190, purge_after_window: false },
      },
    ],
    active: true,
  },
  {
    verticalSlug: "business-travel",
    jurisdiction: `${NG_LAGOS} (LIRS expense documentation overlay)`,
    requiredDocuments: [
      {
        code: "lirs_compliant_invoices",
        label: "LIRS-compliant invoices for Lagos-incurred travel spend",
        issuer: "vendor_or_merchant",
        verification: "invoice_capture_with_tax_breakdown",
        renewal: "per_expense",
        retention_days: 2190,
      },
      {
        code: "cost_center_registration",
        label: "Cost-center registration with the employer finance desk",
        issuer: "employer_finance_desk",
        verification: "cost_center_code_lookup",
        renewal: "annual",
        retention_days: 2190,
      },
    ],
    ageRestriction: null,
    handlingRequirements: [
      {
        code: "lagos_spend_tagging",
        label: "Lagos-incurred expenses tagged for LIRS reporting",
        enforcement: "expense_location_tagging",
        parameters: { tag_at: "submission", required_for_state: "LA" },
      },
      {
        code: "monthly_reconciliation_close",
        label: "Open trips reconciled at month-end close",
        enforcement: "reconciliation_deadline_check",
        parameters: { close_day_of_month: 5, escalate_unreconciled: true },
      },
    ],
    active: true,
  },
  {
    verticalSlug: "courier",
    jurisdiction: `${NG_FEDERAL} (NIPOST courier and logistics regulation)`,
    requiredDocuments: [
      {
        code: "courier_operating_license",
        label: "Courier and logistics operating licence",
        issuer: "nipost_courier_regulatory_department",
        verification: "license_number_lookup",
        renewal: "annual",
        retention_days: 1825,
      },
      {
        code: "rider_competence_certificate",
        label: "Dispatch rider competence certificate",
        issuer: "frsc_accredited_riding_school",
        verification: "certificate_number_lookup",
        renewal: "every_2_years",
        retention_days: 1095,
      },
      {
        code: "vehicle_insurance",
        label: "Third-party (minimum) vehicle insurance certificate",
        issuer: "naicom_licensed_insurer",
        verification: "policy_number_lookup",
        renewal: "annual",
        retention_days: 1825,
      },
    ],
    ageRestriction: null,
    handlingRequirements: [
      {
        code: "prohibited_items_screening",
        label: "Parcels screened against the prohibited-items list at intake",
        enforcement: "intake_declaration_check",
        parameters: { require_sender_declaration: true, block_undeclared_dg: true },
      },
      {
        code: "parcel_seal_integrity",
        label: "Parcels sealed at pickup; broken seals flagged before delivery",
        enforcement: "seal_check_at_handoff",
        parameters: { photo_evidence: true, flag_broken_seal: true },
      },
      {
        code: "proof_of_delivery",
        label: "Recipient signature or OTP captured at dropoff",
        enforcement: "signature_or_otp_capture_at_dropoff",
        parameters: { allow_unattended_dropoff: false },
      },
    ],
    active: true,
  },
  {
    verticalSlug: "courier",
    jurisdiction: `${NG_LAGOS} (Lagos dispatch rider safety overlay)`,
    requiredDocuments: [
      {
        code: "lagos_rider_id_card",
        label: "Lagos State dispatch rider identification card",
        issuer: "lagos_state_ministry_of_transport",
        verification: "rider_id_lookup",
        renewal: "annual",
        retention_days: 1095,
      },
      {
        code: "riders_permit_badge",
        label: "Lagos commercial dispatch rider permit badge",
        issuer: "lastma",
        verification: "badge_number_lookup",
        renewal: "annual",
        retention_days: 1095,
      },
    ],
    ageRestriction: null,
    handlingRequirements: [
      {
        code: "helmet_and_safety_gear",
        label: "Rider helmet and reflective gear verified at shift start",
        enforcement: "shift_start_gear_check",
        parameters: { photo_evidence: true, block_shift_without_gear: true },
      },
      {
        code: "restricted_bridge_hours",
        label: "Dispatch bikes respect Lagos bridge and corridor time windows",
        enforcement: "geofence_and_time_window_check",
        parameters: { check_at: ["dispatch", "pickup", "delivery"] },
      },
    ],
    active: true,
  },
];

export async function seedDefaultCompliancePacksRun(
  actorUserId: number,
  input: z.infer<typeof seedDefaultCompliancePacksInputSchema>,
): Promise<SeedDefaultCompliancePacksResult> {
  const pool = await getPool();
  const ledgerId = `${actorUserId}:${input.idempotencyKey}`;
  const stored = await readLedger<SeedDefaultCompliancePacksResult>(
    pool,
    SEED_TOPIC,
    ledgerId,
  );
  if (stored && typeof stored.packsTouched === "number") {
    return { ...stored, replayed: true };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize concurrent seed runs (0046 advisory-lock pattern).
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('compliance-pack-seed', 0))`,
    );
    let inserted = 0;
    let updated = 0;
    for (const seed of DEFAULT_COMPLIANCE_PACK_SEEDS) {
      const outcome = await upsertPackRow(client, seed);
      if (outcome.inserted) inserted += 1;
      else updated += 1;
    }
    const result: SeedDefaultCompliancePacksResult = {
      verticals: [...new Set(DEFAULT_COMPLIANCE_PACK_SEEDS.map((s) => s.verticalSlug))],
      jurisdictions: [
        ...new Set(DEFAULT_COMPLIANCE_PACK_SEEDS.map((s) => s.jurisdiction)),
      ],
      packsTouched: DEFAULT_COMPLIANCE_PACK_SEEDS.length,
      inserted,
      updated,
      replayed: false,
    };
    await recordLedger(client, SEED_TOPIC, ledgerId, {
      verticals: result.verticals,
      jurisdictions: result.jurisdictions,
      packsTouched: result.packsTouched,
      inserted: result.inserted,
      updated: result.updated,
      replayed: false,
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    mapPackSqlError(error);
  } finally {
    client.release();
  }
}

export const compliancePacksRouter = router({
  list: workspaceReadProcedure
    .input(
      z
        .object({
          vertical: z.string().trim().min(1).max(100).optional(),
        })
        .optional(),
    )
    .query(({ input }) => listCompliancePacks(input?.vertical)),

  summary: workspaceReadProcedure.query(() => getVerticalComplianceSummary()),

  upsertCompliancePack: operatorMutationProcedure("operate")
    .input(upsertCompliancePackInputSchema)
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return upsertCompliancePackRecord(actor.id, input);
    }),

  deactivateCompliancePack: operatorMutationProcedure("operate")
    .input(deactivateCompliancePackInputSchema)
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return deactivateCompliancePackRecord(actor.id, input);
    }),

  seedDefaultCompliancePacks: operatorMutationProcedure("operate")
    .input(seedDefaultCompliancePacksInputSchema)
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return seedDefaultCompliancePacksRun(actor.id, input);
    }),
});
