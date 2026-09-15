import { TRPCError } from "@trpc/server";

import { getPool } from "../db";
import {
  assertConsultationEligible,
  postConsultation,
} from "./workerCouncil";

/**
 * Local-law contract defaults (R15).
 *
 * Each market's worker contract carries a governing law and dispute forum.
 * The defaults are Nigerian law and Lagos courts — the transcript grievance
 * was forum-shopping workers into Estonian arbitration they could never
 * realistically reach, so a market without an explicit row resolves to the
 * Nigerian defaults, and publishing an override is gated on an activated (or
 * SLA-elapsed) worker-council consultation.
 */

export const DEFAULT_GOVERNING_LAW = "Federal Republic of Nigeria";
export const DEFAULT_DISPUTE_FORUM = "Lagos, Nigeria courts";

export type ContractJurisdictionRow = {
  id: string;
  market_id: string;
  governing_law: string;
  dispute_forum: string;
  consumer_protection_overrides: unknown;
  effective_from: string | Date;
  published: boolean;
  consultation_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

export type ContractDefaults = {
  marketId: string;
  governingLaw: string;
  disputeForum: string;
  consumerProtectionOverrides: unknown;
  effectiveFrom: string | Date | null;
  published: boolean;
  consultationId: string | null;
  /** True when no market row exists and the Nigerian defaults were applied. */
  isDefault: boolean;
};

/**
 * Read the contract defaults for a market. Markets without a jurisdiction
 * row resolve to the Nigerian-law defaults (R15: never an absent/foreign
 * default).
 */
export async function getContractDefaults(
  marketId: string,
): Promise<ContractDefaults> {
  const pool = await getPool();
  const result = await pool.query<ContractJurisdictionRow>(
    `SELECT * FROM public.contract_jurisdictions WHERE market_id = $1`,
    [marketId],
  );
  const row = result.rows[0];
  if (!row) {
    return {
      marketId,
      governingLaw: DEFAULT_GOVERNING_LAW,
      disputeForum: DEFAULT_DISPUTE_FORUM,
      consumerProtectionOverrides: {},
      effectiveFrom: null,
      published: false,
      consultationId: null,
      isDefault: true,
    };
  }
  return {
    marketId: row.market_id,
    governingLaw: row.governing_law,
    disputeForum: row.dispute_forum,
    consumerProtectionOverrides: row.consumer_protection_overrides,
    effectiveFrom: row.effective_from,
    published: row.published,
    consultationId: row.consultation_id,
    isDefault: false,
  };
}

/**
 * Advisory worker-council auto-post for contract-default changes — mirrors
 * the autoPostEconomicsConsultation pattern (never blocks the mutation).
 */
async function autoPostContractConsultation(input: {
  actorUserId: number;
  title: string;
  payload: Record<string, unknown>;
}): Promise<string | null> {
  try {
    const consultation = await postConsultation(input.actorUserId, {
      kind: "other",
      title: input.title,
      payload: input.payload,
      responseSlaHours: 72,
    });
    return consultation.id;
  } catch (error) {
    console.warn(
      "[contractDefaults] worker-council consultation auto-post failed; proceeding",
      error,
    );
    return null;
  }
}

/**
 * Upsert a market's contract jurisdiction (unpublished until the
 * consultation gate is cleared via publishContractDefaults). Fields left
 * undefined fall back to the Nigerian defaults — an upsert can never erase
 * the local-law floor.
 */
export async function setContractDefaults(
  actorUserId: number,
  input: {
    marketId: string;
    governingLaw?: string;
    disputeForum?: string;
    consumerProtectionOverrides?: Record<string, unknown>;
    effectiveFrom?: Date;
  },
): Promise<{ jurisdiction: ContractJurisdictionRow; consultationId: string | null }> {
  const pool = await getPool();
  const upserted = await pool.query<ContractJurisdictionRow>(
    `INSERT INTO public.contract_jurisdictions
       (market_id, governing_law, dispute_forum,
        consumer_protection_overrides, effective_from)
     VALUES ($1, $2, $3, $4::jsonb, coalesce($5, now()))
     ON CONFLICT (market_id)
     DO UPDATE SET
       governing_law = EXCLUDED.governing_law,
       dispute_forum = EXCLUDED.dispute_forum,
       consumer_protection_overrides = EXCLUDED.consumer_protection_overrides,
       effective_from = EXCLUDED.effective_from,
       published = false,
       updated_at = now()
     RETURNING *`,
    [
      input.marketId,
      input.governingLaw ?? DEFAULT_GOVERNING_LAW,
      input.disputeForum ?? DEFAULT_DISPUTE_FORUM,
      JSON.stringify(input.consumerProtectionOverrides ?? {}),
      input.effectiveFrom ?? null,
    ],
  );
  let jurisdiction = upserted.rows[0];
  if (!jurisdiction) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "contract_jurisdiction_upsert_failed",
    });
  }
  const consultationId = await autoPostContractConsultation({
    actorUserId,
    title: `Contract defaults ${input.marketId}`,
    payload: {
      jurisdiction_id: jurisdiction.id,
      market_id: input.marketId,
      governing_law: jurisdiction.governing_law,
      dispute_forum: jurisdiction.dispute_forum,
      consumer_protection_overrides:
        input.consumerProtectionOverrides ?? {},
    },
  });
  if (consultationId) {
    const linked = await pool.query<ContractJurisdictionRow>(
      `UPDATE public.contract_jurisdictions
       SET consultation_id = $2, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [jurisdiction.id, consultationId],
    );
    jurisdiction = linked.rows[0] ?? jurisdiction;
  }
  return { jurisdiction, consultationId };
}

/**
 * Publish a market's contract defaults. Requires an activated worker-council
 * consultation (or one whose response SLA has elapsed) — the platform cannot
 * move workers onto new contract terms without consultation.
 */
export async function publishContractDefaults(
  actorUserId: number,
  input: { marketId: string; consultationId: string },
): Promise<ContractJurisdictionRow> {
  const consultation = await assertConsultationEligible(
    input.consultationId,
    "other",
  );
  const pool = await getPool();
  const updated = await pool.query<ContractJurisdictionRow>(
    `UPDATE public.contract_jurisdictions
     SET published = true, consultation_id = $2, updated_at = now()
     WHERE market_id = $1
     RETURNING *`,
    [input.marketId, consultation.id],
  );
  const row = updated.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "contract_jurisdiction_not_found",
    });
  }
  return row;
}
