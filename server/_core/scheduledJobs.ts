import {
  closeLeaderboardPeriod,
  createEmailDigest,
  generateWeeklyDigest,
  getDb,
  markDigestAsSent,
  selectWinningVariant,
} from "../db";

async function getNumericSystemConfig(key: string, fallback: number) {
  const db = await getDb();
  if (!db) {
    return fallback;
  }

  const result = await (db as any).query(
    `SELECT value FROM system_config WHERE key = $1 LIMIT 1`,
    [key],
  ).catch(() => ({ rows: [] }));

  const raw = result.rows?.[0]?.value;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export async function closeLeaderboardJob() {
  const db = await getDb();
  if (!db) {
    return {
      success: false,
      message: "Database unavailable; leaderboard close job was not executed.",
    };
  }

  const activeResult = await (db as any).query(
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
  const db = await getDb();
  if (!db) {
    return {
      success: false,
      message: "Database unavailable; loyalty point expiration was not executed.",
    };
  }

  const expirationDays = await getNumericSystemConfig("loyalty_points_expiration_days", 365);
  const candidateResult = await (db as any).query(
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

    await (db as any).query("BEGIN");
    try {
      const updateResult = await (db as any).query(
        `UPDATE loyalty_points
         SET points_balance = points_balance - $1,
             updated_at = NOW()
         WHERE user_id = $2
           AND points_balance >= $1
         RETURNING user_id, points_balance`,
        [pointsBalance, row.user_id],
      );

      if ((updateResult.rows ?? []).length === 0) {
        await (db as any).query("ROLLBACK");
        continue;
      }

      await (db as any).query(
        `INSERT INTO loyalty_transactions (user_id, transaction_type, points, description)
         VALUES ($1, 'expiration', $2, $3)`,
        [
          row.user_id,
          -pointsBalance,
          `Automatically expired ${pointsBalance} inactive loyalty points after ${expirationDays} days without qualifying activity.`,
        ],
      );

      await (db as any).query("COMMIT");
      expiredAccounts += 1;
      expiredPoints += pointsBalance;
    } catch (error) {
      await (db as any).query("ROLLBACK").catch(() => undefined);
      throw error;
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
  const db = await getDb();
  if (!db) {
    return {
      success: false,
      message: "Database unavailable; A/B winner selection was not executed.",
    };
  }

  const campaignResult = await (db as any).query(
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

export const jobs = {
  closeLeaderboard: closeLeaderboardJob,
  pointsExpiration: expirePointsJob,
  abTestWinner: abTestWinnerJob,
  weeklyDigest: weeklyDigestJob,
};
