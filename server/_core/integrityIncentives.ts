import { TRPCError } from "@trpc/server";

import { getPool } from "../db";
import { ENV } from "./env";
import { FAIL_OPEN_FAST, resilientFetch } from "./resilientFetch";

import { postConsultation } from "./workerCouncil";

/**
 * Two-sided integrity incentives (R10).
 *
 * Riders and drivers accrue integrity streaks from verified telemetry:
 * 'verified_manifest' (rider) and 'verified_completion' (driver) increment
 * the streak; 'violation' resets it to zero (and logs a 'streak_reset'
 * audit event). When the new current streak exactly matches an active
 * reward rule's threshold, a pending reward is recorded with the
 * deterministic idempotency key `${eventId}:${ruleId}` so a replayed event
 * can never grant twice.
 *
 * Reward rules are published (any authenticated user can list them) and rule
 * changes auto-post an advisory worker-council consultation (kind 'other')
 * — fraud becomes structurally expensive, honesty structurally rewarded,
 * and there is no silent global bonus whiplash.
 *
 * After each recorded event the Python incentives worker is notified
 * (POST /incentives/evaluate) strictly fail-open: a worker outage never
 * blocks or rolls back event recording.
 */

export const INTEGRITY_ROLES = ["rider", "driver"] as const;
export type IntegrityRole = (typeof INTEGRITY_ROLES)[number];

export const INTEGRITY_EVENT_TYPES = [
  "verified_manifest",
  "verified_completion",
  "violation",
  "streak_reset",
  "reward_granted",
] as const;
export type IntegrityEventType = (typeof INTEGRITY_EVENT_TYPES)[number];

export const REWARD_TYPES = ["credit", "badge", "priority"] as const;
export type RewardType = (typeof REWARD_TYPES)[number];

/** Event types that increment the current streak. */
export const STREAK_INCREMENT_EVENTS: readonly IntegrityEventType[] = [
  "verified_manifest",
  "verified_completion",
];

export type IntegrityStreakRow = {
  id: string;
  user_id: number | string;
  role: IntegrityRole;
  current_streak: number;
  longest_streak: number;
  last_event_at: string | Date | null;
  updated_at: string | Date;
};

export type IntegrityEventRow = {
  id: string;
  user_id: number | string;
  role: IntegrityRole;
  event_type: IntegrityEventType;
  trip_id: number | string | null;
  detail: unknown;
  created_at: string | Date;
};

export type IntegrityRewardRuleRow = {
  id: string;
  role: IntegrityRole;
  rule_key: string;
  threshold_streak: number;
  reward_type: RewardType;
  amount_minor: number | string | null;
  currency: string;
  active: boolean;
  published_at: string | Date;
};

export type IntegrityRewardRow = {
  id: string;
  user_id: number | string;
  rule_id: string;
  amount_minor: number | string | null;
  currency: string;
  status: "pending" | "granted" | "revoked";
  idempotency_key: string | null;
  granted_at: string | Date | null;
  created_at: string | Date;
};

export type StreakState = {
  currentStreak: number;
  longestStreak: number;
};

/**
 * Pure streak transition, exported for tests and mirrored by the Python
 * incentives worker (services/python/incentives-worker/scoring.py).
 */
export function nextStreakState(
  state: StreakState,
  eventType: IntegrityEventType,
): StreakState & { streakReset: boolean } {
  if (STREAK_INCREMENT_EVENTS.includes(eventType)) {
    const currentStreak = state.currentStreak + 1;
    return {
      currentStreak,
      longestStreak: Math.max(state.longestStreak, currentStreak),
      streakReset: false,
    };
  }
  if (eventType === "violation") {
    return { currentStreak: 0, longestStreak: state.longestStreak, streakReset: true };
  }
  return { ...state, streakReset: false };
}

export async function listRewardRules(): Promise<IntegrityRewardRuleRow[]> {
  const pool = await getPool();
  const result = await pool.query<IntegrityRewardRuleRow>(
    `SELECT * FROM public.integrity_reward_rules
     ORDER BY role, threshold_streak, rule_key`,
  );
  return result.rows;
}

export async function getMyStanding(userId: number): Promise<{
  streaks: IntegrityStreakRow[];
  rewards: IntegrityRewardRow[];
  recentEvents: IntegrityEventRow[];
}> {
  const pool = await getPool();
  const streaks = await pool.query<IntegrityStreakRow>(
    `SELECT * FROM public.integrity_streaks
     WHERE user_id = $1
     ORDER BY role`,
    [userId],
  );
  const rewards = await pool.query<IntegrityRewardRow>(
    `SELECT * FROM public.integrity_rewards
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [userId],
  );
  const recentEvents = await pool.query<IntegrityEventRow>(
    `SELECT * FROM public.integrity_events
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [userId],
  );
  return {
    streaks: streaks.rows,
    rewards: rewards.rows,
    recentEvents: recentEvents.rows,
  };
}

/**
 * Notify the Python incentives worker. Fail-open per module doc: returns
 * whether the worker evaluated the event, never throws.
 */
export async function notifyIncentivesWorker(input: {
  userId: number;
  role: IntegrityRole;
  event: IntegrityEventRow;
  streak: IntegrityStreakRow;
}): Promise<{ workerEvaluated: boolean }> {
  const base = ENV.incentivesWorkerUrl.replace(/\/$/, "");
  try {
    const response = await resilientFetch(`${base}/incentives/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        streak_state: {
          user_id: input.userId,
          role: input.role,
          current_streak: Number(input.streak.current_streak),
          longest_streak: Number(input.streak.longest_streak),
        },
        events: [
          {
            id: input.event.id,
            event_type: input.event.event_type,
            trip_id:
              input.event.trip_id === null ? null : Number(input.event.trip_id),
          },
        ],
      }),
      ...FAIL_OPEN_FAST,
      maxAttempts: 1,
    });
    if (!response.ok) {
      throw new Error(`incentives/evaluate returned status ${response.status}`);
    }
    return { workerEvaluated: true };
  } catch (error) {
    console.warn(
      "[integrityIncentives] incentives worker unavailable; failing open",
      error,
    );
    return { workerEvaluated: false };
  }
}

async function findEventByIdempotencyKey(
  userId: number,
  role: IntegrityRole,
  idempotencyKey: string,
): Promise<IntegrityEventRow | null> {
  const pool = await getPool();
  const result = await pool.query<IntegrityEventRow>(
    `SELECT * FROM public.integrity_events
     WHERE user_id = $1 AND role = $2 AND detail ->> 'idempotency_key' = $3
     ORDER BY created_at ASC
     LIMIT 1`,
    [userId, role, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function getStreakRow(
  userId: number,
  role: IntegrityRole,
): Promise<IntegrityStreakRow | null> {
  const pool = await getPool();
  const result = await pool.query<IntegrityStreakRow>(
    `SELECT * FROM public.integrity_streaks WHERE user_id = $1 AND role = $2`,
    [userId, role],
  );
  return result.rows[0] ?? null;
}

/**
 * Append an integrity event and apply the streak transition. Events with a
 * caller-supplied idempotencyKey are deduplicated (same user+role+key returns
 * the original event without touching the streak or granting rewards again).
 * Rules whose threshold equals the NEW current streak grant a pending reward
 * with idempotency key `${eventId}:${ruleId}` (ON CONFLICT DO NOTHING).
 */
export async function recordIntegrityEvent(
  actorUserId: number,
  input: {
    userId: number;
    role: IntegrityRole;
    eventType: IntegrityEventType;
    tripId?: number;
    detail?: Record<string, unknown>;
    idempotencyKey?: string;
  },
): Promise<{
  event: IntegrityEventRow;
  streak: IntegrityStreakRow | null;
  rewardsGranted: IntegrityRewardRow[];
  duplicate: boolean;
  workerEvaluated: boolean;
}> {
  if (input.idempotencyKey) {
    const existing = await findEventByIdempotencyKey(
      input.userId,
      input.role,
      input.idempotencyKey,
    );
    if (existing) {
      const streak = await getStreakRow(input.userId, input.role);
      return {
        event: existing,
        streak,
        rewardsGranted: [],
        duplicate: true,
        workerEvaluated: false,
      };
    }
  }

  const pool = await getPool();
  const detail: Record<string, unknown> = { ...(input.detail ?? {}) };
  if (input.idempotencyKey) {
    detail.idempotency_key = input.idempotencyKey;
  }
  detail.recorded_by = actorUserId;

  const inserted = await pool.query<IntegrityEventRow>(
    `INSERT INTO public.integrity_events
       (user_id, role, event_type, trip_id, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING *`,
    [
      input.userId,
      input.role,
      input.eventType,
      input.tripId ?? null,
      JSON.stringify(detail),
    ],
  );
  const event = inserted.rows[0];
  if (!event) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "integrity_event_record_failed",
    });
  }

  let streak: IntegrityStreakRow | null = null;
  if (STREAK_INCREMENT_EVENTS.includes(input.eventType)) {
    const upserted = await pool.query<IntegrityStreakRow>(
      `INSERT INTO public.integrity_streaks
         (user_id, role, current_streak, longest_streak, last_event_at, updated_at)
       VALUES ($1, $2, 1, 1, now(), now())
       ON CONFLICT (user_id, role)
       DO UPDATE SET
         current_streak = public.integrity_streaks.current_streak + 1,
         longest_streak = GREATEST(
           public.integrity_streaks.longest_streak,
           public.integrity_streaks.current_streak + 1
         ),
         last_event_at = now(),
         updated_at = now()
       RETURNING *`,
      [input.userId, input.role],
    );
    streak = upserted.rows[0] ?? null;
  } else if (input.eventType === "violation") {
    const upserted = await pool.query<IntegrityStreakRow>(
      `INSERT INTO public.integrity_streaks
         (user_id, role, current_streak, longest_streak, last_event_at, updated_at)
       VALUES ($1, $2, 0, 0, now(), now())
       ON CONFLICT (user_id, role)
       DO UPDATE SET
         current_streak = 0,
         last_event_at = now(),
         updated_at = now()
       RETURNING *`,
      [input.userId, input.role],
    );
    streak = upserted.rows[0] ?? null;
    // Audit trail: a violation that resets the streak is always paired with
    // an explicit streak_reset event.
    await pool.query(
      `INSERT INTO public.integrity_events
         (user_id, role, event_type, trip_id, detail)
       VALUES ($1, $2, 'streak_reset', $3, $4::jsonb)`,
      [
        input.userId,
        input.role,
        input.tripId ?? null,
        JSON.stringify({ reset_by: event.id }),
      ],
    );
  }

  const rewardsGranted: IntegrityRewardRow[] = [];
  if (streak && STREAK_INCREMENT_EVENTS.includes(input.eventType)) {
    const currentStreak = Number(streak.current_streak);
    const rules = await pool.query<IntegrityRewardRuleRow>(
      `SELECT * FROM public.integrity_reward_rules
       WHERE role = $1 AND active = true AND threshold_streak = $2`,
      [input.role, currentStreak],
    );
    for (const rule of rules.rows) {
      const granted = await pool.query<IntegrityRewardRow>(
        `INSERT INTO public.integrity_rewards
           (user_id, rule_id, amount_minor, currency, idempotency_key)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [
          input.userId,
          rule.id,
          rule.amount_minor,
          rule.currency,
          `${event.id}:${rule.id}`,
        ],
      );
      if (granted.rows[0]) {
        rewardsGranted.push(granted.rows[0]);
      }
    }
  }

  const { workerEvaluated } = streak
    ? await notifyIncentivesWorker({
        userId: input.userId,
        role: input.role,
        event,
        streak,
      })
    : { workerEvaluated: false };

  return { event, streak, rewardsGranted, duplicate: false, workerEvaluated };
}

/**
 * Advisory worker-council auto-post for incentive rule changes — mirrors the
 * autoPostEconomicsConsultation pattern (never blocks the mutation).
 */
async function autoPostIncentivesConsultation(input: {
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
      "[integrityIncentives] worker-council consultation auto-post failed; proceeding",
      error,
    );
    return null;
  }
}

export async function upsertRewardRule(
  actorUserId: number,
  input: {
    role: IntegrityRole;
    ruleKey: string;
    thresholdStreak: number;
    rewardType: RewardType;
    amountMinor?: number | null;
    currency?: string;
    active?: boolean;
  },
): Promise<{ rule: IntegrityRewardRuleRow; consultationId: string | null }> {
  if (input.rewardType === "credit" && (input.amountMinor == null || input.amountMinor < 0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "credit_rules_require_amount_minor",
    });
  }
  const pool = await getPool();
  const upserted = await pool.query<IntegrityRewardRuleRow>(
    `INSERT INTO public.integrity_reward_rules
       (role, rule_key, threshold_streak, reward_type, amount_minor, currency, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (role, rule_key)
     DO UPDATE SET
       threshold_streak = EXCLUDED.threshold_streak,
       reward_type = EXCLUDED.reward_type,
       amount_minor = EXCLUDED.amount_minor,
       currency = EXCLUDED.currency,
       active = EXCLUDED.active
     RETURNING *`,
    [
      input.role,
      input.ruleKey,
      input.thresholdStreak,
      input.rewardType,
      input.amountMinor ?? null,
      input.currency ?? "NGN",
      input.active ?? true,
    ],
  );
  const rule = upserted.rows[0];
  if (!rule) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "reward_rule_upsert_failed",
    });
  }
  const consultationId = await autoPostIncentivesConsultation({
    actorUserId,
    title: `Integrity reward rule ${input.role}/${input.ruleKey}`,
    payload: {
      rule_id: rule.id,
      role: input.role,
      rule_key: input.ruleKey,
      threshold_streak: input.thresholdStreak,
      reward_type: input.rewardType,
      amount_minor: input.amountMinor ?? null,
      active: input.active ?? true,
    },
  });
  return { rule, consultationId };
}

export async function grantReward(
  actorUserId: number,
  input: { rewardId: string },
): Promise<IntegrityRewardRow> {
  const pool = await getPool();
  const updated = await pool.query<IntegrityRewardRow>(
    `UPDATE public.integrity_rewards
     SET status = 'granted', granted_at = now()
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [input.rewardId],
  );
  const row = updated.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "reward_not_pending",
    });
  }
  await pool.query(
    `INSERT INTO public.integrity_events (user_id, role, event_type, detail)
     SELECT r.user_id, rr.role, 'reward_granted', $2::jsonb
     FROM public.integrity_rewards r
     JOIN public.integrity_reward_rules rr ON rr.id = r.rule_id
     WHERE r.id = $1`,
    [input.rewardId, JSON.stringify({ reward_id: input.rewardId, granted_by: actorUserId })],
  );
  return row;
}

export async function revokeReward(
  actorUserId: number,
  input: { rewardId: string; reason?: string },
): Promise<IntegrityRewardRow> {
  const pool = await getPool();
  const updated = await pool.query<IntegrityRewardRow>(
    `UPDATE public.integrity_rewards
     SET status = 'revoked'
     WHERE id = $1 AND status IN ('pending', 'granted')
     RETURNING *`,
    [input.rewardId],
  );
  const row = updated.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "reward_not_revocable",
    });
  }
  await pool.query(
    `UPDATE public.integrity_events
     SET detail = detail || $2::jsonb
     WHERE event_type = 'reward_granted' AND detail ->> 'reward_id' = $1`,
    [
      input.rewardId,
      JSON.stringify({ revoked_by: actorUserId, reason: input.reason ?? null }),
    ],
  );
  return row;
}
