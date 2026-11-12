import { z } from "zod";
import { TRPCError } from "@trpc/server";

import {
  applyReferralCode as engineApplyReferralCode,
  createCampaign as engineCreateCampaign,
  getCampaigns,
  getCurrentLeaderboardPeriod,
  getLoyaltyAccount,
  getLoyaltyRewards,
  getLoyaltyStats,
  getPool,
  getReferralLeaderboard,
  updateCampaign as engineUpdateCampaign,
} from "../db";
import { generateShareCode } from "./consumerCommerce";
import { resolvePublicUser } from "./publicUsers";
import {
  authenticatedProcedure,
  operatorMutationProcedure,
  publicProcedure,
  router,
} from "./trpc";

/**
 * Growth engine router (P5-PILOT consumer-parity wave): the first tRPC
 * surface for the existing referral/loyalty/campaign engine in
 * server/db.ts:1440-2450. This router is a thin binding — all mutation
 * semantics (transactional referral apply/complete, idempotency-ledger
 * replay, loyalty arithmetic, campaign CRUD, leaderboard aggregation) live
 * in the db.ts engine and are NOT re-implemented here.
 *
 * Consumer lane: every consumer procedure is an authenticatedProcedure
 * scoped to the caller's own identity, resolved into the public.users ID
 * space via resolvePublicUser (consumerRouter.ts convention). Only THAT id
 * is ever passed to the engine/query layer, so one consumer can never read
 * or reference another consumer's referrals or loyalty journal.
 *
 * Operator lane: createCampaign/updateCampaign/leaderboardSummary go through
 * operatorMutationProcedure("operate") (operator role + MFA assertion +
 * workspace-scoped policy grant, see trpc.ts:171).
 *
 * Money/points: loyalty points are integer minor units end to end; no
 * floating point is introduced anywhere in this surface.
 *
 * Reads that the engine does not already expose as functions
 * (myReferralCode, myReferrals, myLoyaltyTransactions) are direct
 * caller-pinned SELECTs on public.users / public.customer_referrals /
 * public.loyalty_transactions — the same pattern consumerQueries.ts uses for
 * the wallet loyalty block.
 */

// Platform idempotency-key format (merchantSelfServe.ts:68-70 pattern,
// inline redefinition per consumerRouter.ts:62-64 convention).
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const idempotencyKeySchema = z.string().regex(IDEMPOTENCY_KEY_REGEX);

const limitInput = z
  .object({ limit: z.number().int().min(1).max(100).default(25) })
  .optional();

const applyReferralCodeInputSchema = z.object({
  referralCode: z.string().trim().min(4).max(50),
  idempotencyKey: idempotencyKeySchema,
});

const createCampaignInputSchema = z.object({
  campaignName: z.string().trim().min(2).max(255),
  campaignType: z.string().trim().min(2).max(64),
  emailTemplate: z.string().max(20000).optional(),
  smsTemplate: z.string().max(2000).optional(),
  targetAudience: z.string().trim().min(2).max(64).default("all"),
  triggerCondition: z.record(z.string(), z.unknown()).optional(),
});

const updateCampaignInputSchema = z.object({
  campaignId: z.number().int().positive(),
  updates: z
    .object({
      campaign_name: z.string().trim().min(2).max(255).optional(),
      campaign_type: z.string().trim().min(2).max(64).optional(),
      email_template: z.string().max(20000).optional(),
      sms_template: z.string().max(2000).optional(),
      target_audience: z.string().trim().min(2).max(64).optional(),
      trigger_condition: z.record(z.string(), z.unknown()).optional(),
      is_active: z.boolean().optional(),
    })
    .refine((value) => Object.values(value).some((field) => field !== undefined), {
      message: "at least one campaign field must be provided",
    }),
});

/** Engine error mapping, consumerCommerce.mapConsumerCheckoutError convention. */
function mapGrowthError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  const pgCode = (error as { code?: string })?.code;
  const message = (error as Error)?.message ?? "growth_engine_failed";
  if (message === "Invalid referral code") {
    throw new TRPCError({ code: "BAD_REQUEST", message, cause: error });
  }
  if (message === "Users cannot apply their own referral code") {
    throw new TRPCError({ code: "BAD_REQUEST", message, cause: error });
  }
  if (message === "User has already used a referral code") {
    throw new TRPCError({ code: "CONFLICT", message, cause: error });
  }
  switch (pgCode) {
    case "22023":
      throw new TRPCError({ code: "BAD_REQUEST", message, cause: error });
    case "P0002":
      throw new TRPCError({ code: "NOT_FOUND", message, cause: error });
    case "42501":
      throw new TRPCError({ code: "FORBIDDEN", message, cause: error });
    case "23505":
    case "23514":
    case "55000":
      throw new TRPCError({ code: "CONFLICT", message, cause: error });
    default:
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "growth_engine_failed",
        cause: error,
      });
  }
}

function engineUnavailable(operation: string): never {
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `GROWTH_ENGINE_UNAVAILABLE:${operation}`,
  });
}

const toNumber = (value: unknown) => Number(value ?? 0);
const toIso = (value: unknown) =>
  value ? new Date(value as string).toISOString() : null;

/**
 * Lazily provision the caller's referral code. users.referral_code has no
 * UNIQUE constraint (init-local-postgres.sql:1 / 0105), so generation does a
 * collision check before the claim update; the UPDATE is guarded with
 * `referral_code IS NULL` so a concurrent claim can never overwrite an
 * existing code. Codes are 8-char Crockford-ish (generateShareCode, no
 * I/L/O/U) — the same alphabet consumers already read aloud for group
 * orders.
 */
async function ensureReferralCode(userId: number): Promise<string> {
  const pool = await getPool();
  const existing = await pool.query<{ referral_code: string | null }>(
    `SELECT referral_code FROM public.users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const existingCode = existing.rows[0]?.referral_code;
  if (existingCode && existingCode.trim().length > 0) {
    return existingCode;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateShareCode();
    const collision = await pool.query(
      `SELECT 1 FROM public.users WHERE referral_code = $1 LIMIT 1`,
      [candidate],
    );
    if (collision.rows.length > 0) continue;
    const claimed = await pool.query<{ referral_code: string }>(
      `UPDATE public.users
       SET referral_code = $2
       WHERE id = $1 AND referral_code IS NULL
       RETURNING referral_code`,
      [userId, candidate],
    );
    if (claimed.rows[0]?.referral_code) return claimed.rows[0].referral_code;
    // Lost a concurrent claim race — re-read; the winner's code is ours too.
    const reread = await pool.query<{ referral_code: string | null }>(
      `SELECT referral_code FROM public.users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (reread.rows[0]?.referral_code) return reread.rows[0].referral_code;
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "referral_code_provisioning_failed",
  });
}

export const growthRouter = router({
  myReferralCode: authenticatedProcedure.query(async ({ ctx }) => {
    const publicUser = await resolvePublicUser(ctx.user);
    const referralCode = await ensureReferralCode(publicUser.id);
    return { referralCode };
  }),

  myReferrals: authenticatedProcedure
    .input(limitInput)
    .query(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      const pool = await getPool();
      const limit = input?.limit ?? 25;
      const [rows, totals] = await Promise.all([
        pool.query(
          `SELECT cr.id,
                  cr.referral_code,
                  cr.status,
                  cr.referrer_bonus_points,
                  cr.referred_bonus_points,
                  cr.created_at,
                  cr.completed_at,
                  u.name AS referred_name
           FROM public.customer_referrals cr
           LEFT JOIN public.users u ON u.id = cr.referred_id
           WHERE cr.referrer_id = $1
           ORDER BY cr.created_at DESC
           LIMIT $2`,
          [publicUser.id, limit],
        ),
        pool.query(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
                  COUNT(*) FILTER (WHERE status IN ('completed', 'rewarded'))::int AS successful
           FROM public.customer_referrals
           WHERE referrer_id = $1`,
          [publicUser.id],
        ),
      ]);
      const summary = totals.rows[0] ?? { total: 0, pending: 0, successful: 0 };
      return {
        summary: {
          total: toNumber(summary.total),
          pending: toNumber(summary.pending),
          successful: toNumber(summary.successful),
        },
        referrals: rows.rows.map((row: any) => ({
          id: Number(row.id),
          referralCode: String(row.referral_code),
          status: String(row.status),
          referrerBonusPoints: toNumber(row.referrer_bonus_points),
          referredBonusPoints: toNumber(row.referred_bonus_points),
          referredName: row.referred_name ? String(row.referred_name) : null,
          createdAt: toIso(row.created_at),
          completedAt: toIso(row.completed_at),
        })),
      };
    }),

  applyReferralCode: authenticatedProcedure
    .input(applyReferralCodeInputSchema)
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      try {
        const referral = await engineApplyReferralCode(
          publicUser.id,
          input.referralCode,
          input.idempotencyKey,
        );
        if (!referral) engineUnavailable("referral.apply_code");
        return {
          id: Number(referral.id),
          referralCode: String(referral.referral_code),
          status: String(referral.status),
          referrerBonusPoints: toNumber(referral.referrer_bonus_points),
          referredBonusPoints: toNumber(referral.referred_bonus_points),
          createdAt: toIso(referral.created_at),
          completedAt: toIso(referral.completed_at),
        };
      } catch (error) {
        mapGrowthError(error);
      }
    }),

  myLoyaltyBalance: authenticatedProcedure.query(async ({ ctx }) => {
    const publicUser = await resolvePublicUser(ctx.user);
    const account = await getLoyaltyAccount(publicUser.id);
    if (!account) engineUnavailable("loyalty.balance");
    return {
      pointsBalance: toNumber(account.points_balance),
      lifetimePoints: toNumber(account.lifetime_points),
      tier: String(account.tier ?? "bronze"),
      tierProgress: toNumber(account.tier_progress),
      nextTierThreshold: toNumber(account.next_tier_threshold),
    };
  }),

  myLoyaltyTransactions: authenticatedProcedure
    .input(limitInput)
    .query(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      const pool = await getPool();
      const result = await pool.query(
        `SELECT id, transaction_type, points, order_id, description, created_at
         FROM public.loyalty_transactions
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [publicUser.id, input?.limit ?? 25],
      );
      return result.rows.map((row: any) => ({
        id: Number(row.id),
        transactionType: String(row.transaction_type),
        points: toNumber(row.points),
        orderId:
          row.order_id === null || row.order_id === undefined
            ? null
            : Number(row.order_id),
        description: row.description ?? null,
        createdAt: toIso(row.created_at),
      }));
    }),

  listRewardsCatalog: publicProcedure.query(async () => {
    const rewards = await getLoyaltyRewards({ activeOnly: true });
    return rewards.map((reward: any) => ({
      id: Number(reward.id),
      rewardName: String(reward.reward_name),
      description: reward.description ?? null,
      pointsCost: toNumber(reward.points_cost),
      rewardType: String(reward.reward_type),
      rewardValue: reward.reward_value ?? null,
      minTier: reward.min_tier ?? null,
      expiresAt: toIso(reward.expires_at),
    }));
  }),

  /**
   * Public consumer-safe campaign read: only campaigns an operator has
   * flipped to status='active' within their schedule window, stripped of
   * operator-only fields (budgets, templates, funnel counters).
   */
  listActiveCampaigns: publicProcedure.query(async () => {
    const campaigns = await getCampaigns(true);
    const now = Date.now();
    return campaigns
      .filter((campaign: any) => {
        if (String(campaign.status) !== "active") return false;
        const startsAt = campaign.starts_at
          ? new Date(campaign.starts_at).getTime()
          : null;
        const endsAt = campaign.ends_at
          ? new Date(campaign.ends_at).getTime()
          : null;
        if (startsAt !== null && startsAt > now) return false;
        if (endsAt !== null && endsAt < now) return false;
        return true;
      })
      .map((campaign: any) => ({
        id: Number(campaign.id),
        campaignName: String(campaign.campaign_name),
        campaignType: String(campaign.campaign_type),
        channel: String(campaign.channel ?? "email"),
        targetAudience: String(campaign.target_audience ?? "all"),
        startsAt: toIso(campaign.starts_at),
        endsAt: toIso(campaign.ends_at),
      }));
  }),

  createCampaign: operatorMutationProcedure("operate")
    .input(createCampaignInputSchema)
    .mutation(async ({ input }) => {
      const campaign = await engineCreateCampaign({
        campaign_name: input.campaignName,
        campaign_type: input.campaignType,
        email_template: input.emailTemplate,
        sms_template: input.smsTemplate,
        target_audience: input.targetAudience,
        trigger_condition: input.triggerCondition,
      });
      if (!campaign) engineUnavailable("campaign.create");
      return campaign;
    }),

  updateCampaign: operatorMutationProcedure("operate")
    .input(updateCampaignInputSchema)
    .mutation(async ({ input }) => {
      const campaign = await engineUpdateCampaign(input.campaignId, input.updates);
      if (!campaign) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "campaign_not_found",
        });
      }
      return campaign;
    }),

  leaderboardSummary: operatorMutationProcedure("operate")
    .input(limitInput)
    .query(async ({ input }) => {
      const [period, entries, loyalty] = await Promise.all([
        getCurrentLeaderboardPeriod(),
        getReferralLeaderboard(undefined, input?.limit ?? 25),
        getLoyaltyStats(),
      ]);
      return {
        period: period
          ? {
              id: Number(period.id),
              periodName: String(period.period_name),
              periodStart: toIso(period.period_start),
              periodEnd: toIso(period.period_end),
              status: String(period.status),
            }
          : null,
        entries: entries.map((entry: any) => ({
          userId: Number(entry.user_id),
          userName: entry.user_name ? String(entry.user_name) : null,
          referralCount: toNumber(entry.referral_count),
          successfulReferrals: toNumber(entry.successful_referrals),
          pointsEarned: toNumber(entry.points_earned),
          rank: entry.rank === null || entry.rank === undefined ? null : Number(entry.rank),
          rewardTier: String(entry.reward_tier ?? "none"),
          rewardPoints: toNumber(entry.reward_points),
        })),
        loyalty: loyalty
          ? {
              totalMembers: toNumber(loyalty.total_members),
              totalPointsOutstanding: toNumber(loyalty.total_points_outstanding),
              totalPointsAwarded: toNumber(loyalty.total_points_awarded),
            }
          : null,
      };
    }),
});

export type GrowthRouter = typeof growthRouter;
