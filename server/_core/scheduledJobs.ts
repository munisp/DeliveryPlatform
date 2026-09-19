import type { Pool } from "pg";
import {
  closeLeaderboardPeriod,
  createEmailDigest,
  generateWeeklyDigest,
  getPool,
  markDigestAsSent,
  selectWinningVariant,
} from "../db";
import { dispatchDeveloperWebhooks } from "./developerWebhookDispatcher";
import { sendEmail, sendSMS } from "./notificationGateway";

async function getPoolOrNull(): Promise<Pool | null> {
  return getPool().catch(() => null);
}

async function getNumericSystemConfig(key: string, fallback: number) {
  const pool = await getPoolOrNull();
  if (!pool) {
    return fallback;
  }

  const result = await pool.query(
    `SELECT value FROM system_config WHERE key = $1 LIMIT 1`,
    [key],
  ).catch(() => ({ rows: [] as Array<{ value: unknown }> }));

  const raw = result.rows?.[0]?.value;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export async function closeLeaderboardJob() {
  const pool = await getPoolOrNull();
  if (!pool) {
    return {
      success: false,
      message: "Database unavailable; leaderboard close job was not executed.",
    };
  }

  const activeResult = await pool.query(
    `SELECT id
     FROM referral_leaderboard_periods
     WHERE is_active = true
     ORDER BY period_start DESC
     LIMIT 1`,
  );

  const activePeriodId = activeResult.rows?.[0]?.id;
  if (!activePeriodId) {
    return {
      success: true,
      message: "No active leaderboard period required closure.",
      periodId: null,
    };
  }

  const summary = await closeLeaderboardPeriod(Number(activePeriodId));
  return {
    success: true,
    message: `Closed leaderboard period ${activePeriodId} and opened the next period.`,
    periodId: Number(activePeriodId),
    summary,
  };
}

export async function expirePointsJob() {
  const pool = await getPoolOrNull();
  if (!pool) {
    return {
      success: false,
      message: "Database unavailable; loyalty point expiration was not executed.",
    };
  }

  const expirationDays = await getNumericSystemConfig("loyalty_points_expiration_days", 365);
  const candidateResult = await pool.query(
    `SELECT
       lp.user_id,
       lp.points_balance,
       COALESCE(MAX(lt.created_at), lp.updated_at, lp.created_at) AS last_activity_at
     FROM loyalty_points lp
     LEFT JOIN loyalty_transactions lt ON lt.user_id = lp.user_id
     WHERE lp.points_balance > 0
     GROUP BY lp.user_id, lp.points_balance, lp.updated_at, lp.created_at
     HAVING COALESCE(MAX(lt.created_at), lp.updated_at, lp.created_at) < NOW() - ($1 || ' days')::interval`,
    [expirationDays],
  );

  let expiredAccounts = 0;
  let expiredPoints = 0;

  for (const row of candidateResult.rows ?? []) {
    const pointsBalance = Number(row.points_balance || 0);
    if (!Number.isFinite(pointsBalance) || pointsBalance <= 0) {
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const updateResult = await client.query(
        `UPDATE loyalty_points
         SET points_balance = points_balance - $1,
             updated_at = NOW()
         WHERE user_id = $2
           AND points_balance >= $1
         RETURNING user_id, points_balance`,
        [pointsBalance, row.user_id],
      );

      if ((updateResult.rows ?? []).length === 0) {
        await client.query("ROLLBACK");
        continue;
      }

      await client.query(
        `INSERT INTO loyalty_transactions (user_id, transaction_type, points, description)
         VALUES ($1, 'expiration', $2, $3)`,
        [
          row.user_id,
          -pointsBalance,
          `Automatically expired ${pointsBalance} inactive loyalty points after ${expirationDays} days without qualifying activity.`,
        ],
      );

      await client.query("COMMIT");
      expiredAccounts += 1;
      expiredPoints += pointsBalance;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    success: true,
    message: expiredAccounts > 0
      ? `Expired ${expiredPoints} loyalty points across ${expiredAccounts} inactive accounts.`
      : "No inactive loyalty balances met the configured expiration threshold.",
    expirationDays,
    expiredAccounts,
    expiredPoints,
  };
}

export async function abTestWinnerJob() {
  const pool = await getPoolOrNull();
  if (!pool) {
    return {
      success: false,
      message: "Database unavailable; A/B winner selection was not executed.",
    };
  }

  const campaignResult = await pool.query(
    `SELECT mc.id
     FROM marketing_campaigns mc
     WHERE mc.status = 'active'
       AND EXISTS (
         SELECT 1
         FROM campaign_variants cv
         WHERE cv.campaign_id = mc.id
         GROUP BY cv.campaign_id
         HAVING COUNT(*) >= 2
       )
     ORDER BY mc.updated_at DESC NULLS LAST, mc.created_at DESC NULLS LAST`,
  );

  const processed: Array<{ campaignId: number; winner: string | null; confidence: number }> = [];
  for (const row of campaignResult.rows ?? []) {
    const result = await selectWinningVariant(Number(row.id)).catch((error: Error) => ({
      winner: null,
      confidence: 0,
      error: error.message,
    }));

    processed.push({
      campaignId: Number(row.id),
      winner: result?.winner?.variant_name ?? null,
      confidence: Number(result?.confidence || 0),
    });
  }

  const winnersSelected = processed.filter((entry) => entry.winner).length;
  return {
    success: true,
    message: winnersSelected > 0
      ? `Selected winners for ${winnersSelected} active experiments.`
      : "No active experiments had statistically significant winners.",
    processed,
  };
}

export async function weeklyDigestJob() {
  const digest = await generateWeeklyDigest();
  if (!digest) {
    return {
      success: false,
      message: "Database unavailable; weekly digest generation was not executed.",
    };
  }

  const recipientEmail = process.env.WEEKLY_DIGEST_EMAIL?.trim() || "ops@switchos.local";
  const subject = `SwitchOS Weekly Growth Digest · ${new Date(digest.periodEnd).toISOString().slice(0, 10)}`;
  const htmlContent = [
    `<h1>SwitchOS Weekly Growth Digest</h1>`,
    `<p>Period: ${new Date(digest.periodStart).toISOString()} to ${new Date(digest.periodEnd).toISOString()}</p>`,
    `<p>Total leaderboard periods touched: ${digest.leaderboardStats?.total_periods ?? 0}</p>`,
    `<p>Total campaigns created: ${digest.campaignStats?.total_campaigns ?? 0}</p>`,
    `<p>New completed referrals: ${digest.referralStats?.new_referrals ?? 0}</p>`,
  ].join("");

  const record = await createEmailDigest({
    digestType: "weekly_growth",
    periodStart: new Date(digest.periodStart),
    periodEnd: new Date(digest.periodEnd),
    recipientEmail,
    subject,
    htmlContent,
  });

  if (record?.id) {
    await markDigestAsSent(Number(record.id));
  }

  return {
    success: true,
    message: "Generated and recorded the weekly digest.",
    digestId: record?.id ?? null,
    recipientEmail,
  };
}

/**
 * Verification outbox consumer sweep (Audit A cross-cutting 2): the
 * verification engine appends case lifecycle events to
 * verification.outbox_event but nothing consumed them. This sweep claims a
 * batch (consumed_at marker + FOR UPDATE SKIP LOCKED, idempotent under
 * concurrent sweeps), notifies each case subject of the event (fail-open per
 * event — a notification outage never loses the consumed marker), and then
 * flushes pending developer webhook deliveries through the existing
 * dispatcher.
 */
export async function verificationOutboxSweepJob(limit = 50) {
  const pool = await getPoolOrNull();
  if (!pool) {
    return {
      success: false,
      message: "Database unavailable; verification outbox sweep was not executed.",
    };
  }

  const bounded = Math.min(200, Math.max(1, Math.trunc(limit)));
  const claimed = await pool.query<{
    id: string;
    case_id: string;
    event_type: string;
    payload: unknown;
    created_at: string | Date;
  }>(
    `UPDATE verification.outbox_event
     SET consumed_at = now()
     WHERE id IN (
       SELECT id FROM verification.outbox_event
       WHERE consumed_at IS NULL
       ORDER BY created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, case_id, event_type, payload, created_at`,
    [bounded],
  );

  let notified = 0;
  for (const event of claimed.rows ?? []) {
    try {
      const subject = await pool.query<{
        subject_user_id: number | null;
        subject_type: string;
        subject_key: string;
      }>(
        `SELECT subject_user_id, subject_type::text AS subject_type, subject_key
         FROM verification.verification_case WHERE id = $1`,
        [event.case_id],
      );
      const subjectUserId = subject.rows[0]?.subject_user_id;
      if (subjectUserId == null) continue;
      const contact = await pool.query<{
        email: string | null;
        phone: string | null;
      }>(`SELECT email, phone FROM public.users WHERE id = $1`, [
        subjectUserId,
      ]);
      const user = contact.rows[0];
      const message = `Verification update (${event.event_type}) for your ${subject.rows[0]?.subject_type} verification case ${event.case_id}.`;
      const metadata = {
        notificationType: event.event_type,
        caseId: event.case_id,
      };
      if (user?.email) {
        await sendEmail(user.email, "SwitchOS verification update", message, metadata);
        notified += 1;
      } else if (user?.phone) {
        await sendSMS(user.phone, message, metadata);
        notified += 1;
      }
    } catch (error) {
      console.warn(
        `[scheduledJobs] verification outbox notification for case ${event.case_id} failed; continuing`,
        error,
      );
    }
  }

  let webhookResult: unknown = null;
  try {
    webhookResult = await dispatchDeveloperWebhooks(bounded);
  } catch (error) {
    console.warn(
      "[scheduledJobs] developer webhook dispatch after verification sweep failed; continuing",
      error,
    );
  }

  const consumed = claimed.rowCount ?? claimed.rows?.length ?? 0;
  return {
    success: true,
    message: `Consumed ${consumed} verification outbox events (notified ${notified} subjects).`,
    consumed,
    notified,
    webhooks: webhookResult,
  };
}

export const VERIFICATION_MANUAL_REVIEW_SLA_HOURS = 72;

/**
 * Verification SLA sweep (Audit A P1-9 / cross-cutting 5): cases stuck in
 * manual_review beyond the SLA get an escalation outbox event (idempotent —
 * one per case via a deterministic idempotency key) and operators are
 * notified (fail-open). Without this, cases could stall in manual_review
 * forever with no aging signal.
 */
export async function verificationSlaSweepJob(
  thresholdHours = VERIFICATION_MANUAL_REVIEW_SLA_HOURS,
) {
  const pool = await getPoolOrNull();
  if (!pool) {
    return {
      success: false,
      message: "Database unavailable; verification SLA sweep was not executed.",
    };
  }

  const boundedHours = Math.min(24 * 30, Math.max(1, Math.trunc(thresholdHours)));
  const aging = await pool.query<{
    id: string;
    subject_type: string;
    subject_key: string;
    subject_user_id: number | null;
    updated_at: string | Date;
  }>(
    `SELECT id, subject_type::text AS subject_type, subject_key, subject_user_id, updated_at
     FROM verification.verification_case
     WHERE state = 'manual_review'
       AND updated_at < now() - ($1 || ' hours')::interval
     ORDER BY updated_at
     LIMIT 200`,
    [boundedHours],
  );

  let escalated = 0;
  let operatorsNotified = 0;
  for (const row of aging.rows ?? []) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO verification.outbox_event (case_id, event_type, payload, idempotency_key)
       VALUES ($1, 'verification.case.sla_escalated', $2::jsonb, $3)
       ON CONFLICT (case_id, event_type, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        row.id,
        JSON.stringify({
          case_id: row.id,
          subject_type: row.subject_type,
          subject_key: row.subject_key,
          state: "manual_review",
          sla_hours: boundedHours,
          stale_since: row.updated_at,
        }),
        `verification-sla-${row.id}`,
      ],
    );
    if (!inserted.rows[0]) continue; // already escalated — sweep is idempotent
    escalated += 1;
    try {
      const operators = await pool.query<{ email: string | null }>(
        `SELECT email FROM public.users
         WHERE role = 'admin' AND email IS NOT NULL
         LIMIT 10`,
      );
      for (const operator of operators.rows) {
        if (!operator.email) continue;
        try {
          await sendEmail(
            operator.email,
            "SwitchOS verification SLA escalation",
            `Verification case ${row.id} (${row.subject_type} / ${row.subject_key}) has been in manual_review for over ${boundedHours} hours and needs operator attention.`,
            {
              notificationType: "verification.case.sla_escalated",
              caseId: row.id,
            },
          );
          operatorsNotified += 1;
        } catch (error) {
          console.warn(
            `[scheduledJobs] SLA escalation notice to operator failed for case ${row.id}; continuing`,
            error,
          );
        }
      }
    } catch (error) {
      console.warn(
        `[scheduledJobs] operator lookup for SLA escalation of case ${row.id} failed; continuing`,
        error,
      );
    }
  }

  return {
    success: true,
    message:
      escalated > 0
        ? `Escalated ${escalated} verification cases breaching the ${boundedHours}h manual-review SLA.`
        : "No verification cases breached the manual-review SLA.",
    thresholdHours: boundedHours,
    aged: aging.rows?.length ?? 0,
    escalated,
    operatorsNotified,
  };
}

export const jobs = {
  closeLeaderboard: closeLeaderboardJob,
  pointsExpiration: expirePointsJob,
  abTestWinner: abTestWinnerJob,
  weeklyDigest: weeklyDigestJob,
  verificationOutboxSweep: verificationOutboxSweepJob,
  verificationSlaSweep: verificationSlaSweepJob,
};
