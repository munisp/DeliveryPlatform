import { useState, type FormEvent } from "react";
import { Copy, Gift, Megaphone, Share2, Trophy } from "lucide-react";

import { ConsumerLayout } from "@/components/ConsumerLayout";
import { EmptyState, QueryErrorState } from "@/components/QueryState";
import { trpc } from "@/lib/trpc";

function newIdempotencyKey() {
  // Stable for the lifetime of the form so resubmits/replays are absorbed by
  // the server-side referral.apply_code idempotency ledger (db.ts:1672).
  return crypto.randomUUID();
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString();
}

export default function ConsumerReferrals() {
  const utils = trpc.useUtils();
  const referralCode = trpc.growth.myReferralCode.useQuery();
  const referrals = trpc.growth.myReferrals.useQuery({ limit: 50 });
  const balance = trpc.growth.myLoyaltyBalance.useQuery();
  const rewards = trpc.growth.listRewardsCatalog.useQuery();
  const campaigns = trpc.growth.listActiveCampaigns.useQuery();

  const [codeInput, setCodeInput] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [formError, setFormError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const applyCode = trpc.growth.applyReferralCode.useMutation({
    onSuccess: (referral) => {
      setApplied(referral.referralCode);
      setCodeInput("");
      setFormError(null);
      setIdempotencyKey(newIdempotencyKey());
      utils.growth.myReferrals.invalidate();
      utils.growth.myLoyaltyBalance.invalidate();
      utils.growth.myLoyaltyTransactions.invalidate();
    },
    onError: (error) => {
      setFormError(error.message);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    setApplied(null);
    applyCode.mutate({ referralCode: codeInput.trim(), idempotencyKey });
  };

  const code = referralCode.data?.referralCode ?? null;
  const shareMessage = code
    ? `Join SwitchOS with my referral code ${code} and we both earn loyalty points!`
    : null;
  const whatsappShareUrl = shareMessage
    ? `https://wa.me/?text=${encodeURIComponent(shareMessage)}`
    : null;

  const copyCode = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <ConsumerLayout
      title="Referrals & rewards"
      description="Share your referral code, track who joined, and spend your loyalty points — live from the growth engine."
    >
      <div className="space-y-8">
        <section className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-stone-200 bg-white p-6">
            <div className="flex items-center gap-2 text-sm text-stone-500">
              <Share2 className="h-4 w-4 text-amber-700" />
              Your referral code
            </div>
            {referralCode.isError ? (
              <QueryErrorState
                resource="your referral code"
                message={referralCode.error.message}
                onRetry={() => referralCode.refetch()}
                retrying={referralCode.isRefetching}
              />
            ) : referralCode.isLoading ? (
              <p className="mt-2 text-sm text-stone-500">Loading…</p>
            ) : code ? (
              <>
                <p className="mt-2 font-mono text-3xl font-semibold tracking-wider text-stone-900">
                  {code}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={copyCode}
                    className="inline-flex items-center gap-1 rounded-full border border-stone-300 px-3 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
                  >
                    <Copy className="h-3 w-3" />
                    {copied ? "Copied" : "Copy"}
                  </button>
                  {whatsappShareUrl ? (
                    <a
                      href={whatsappShareUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-full bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700"
                    >
                      <Share2 className="h-3 w-3" />
                      Share on WhatsApp
                    </a>
                  ) : null}
                </div>
              </>
            ) : (
              <p className="mt-2 text-sm text-stone-500">
                No referral code is attached to this account.
              </p>
            )}
          </div>

          <div className="rounded-2xl border border-stone-200 bg-white p-6">
            <div className="flex items-center gap-2 text-sm text-stone-500">
              <Trophy className="h-4 w-4 text-amber-700" />
              Loyalty balance
            </div>
            {balance.isError ? (
              <QueryErrorState
                resource="your loyalty balance"
                message={balance.error.message}
                onRetry={() => balance.refetch()}
                retrying={balance.isRefetching}
              />
            ) : balance.isLoading ? (
              <p className="mt-2 text-sm text-stone-500">Loading…</p>
            ) : balance.data ? (
              <>
                <p className="mt-2 text-3xl font-semibold text-stone-900">
                  {balance.data.pointsBalance.toLocaleString()} pts
                </p>
                <p className="mt-1 text-xs text-stone-400">
                  {balance.data.tier} tier · {balance.data.lifetimePoints.toLocaleString()} lifetime
                  points
                  {balance.data.nextTierThreshold > 0
                    ? ` · next tier at ${balance.data.nextTierThreshold.toLocaleString()}`
                    : ""}
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-stone-500">No loyalty account yet.</p>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-stone-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-stone-900">Have a friend's code?</h2>
          <form onSubmit={submit} className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={codeInput}
              onChange={(event) => setCodeInput(event.target.value.toUpperCase())}
              placeholder="ENTER CODE"
              className="w-48 rounded-lg border border-stone-300 px-3 py-2 font-mono text-sm uppercase"
              maxLength={50}
              required
            />
            <button
              type="submit"
              disabled={applyCode.isPending || codeInput.trim().length < 4}
              className="rounded-lg bg-amber-700 px-4 py-2 text-sm font-medium text-white hover:bg-amber-800 disabled:opacity-50"
            >
              {applyCode.isPending ? "Applying…" : "Apply code"}
            </button>
          </form>
          {formError ? (
            <p className="mt-2 text-sm text-red-600">{formError}</p>
          ) : applied ? (
            <p className="mt-2 text-sm text-green-700">
              Code {applied} applied — welcome bonus points are on your balance.
            </p>
          ) : null}
        </section>

        <section>
          <h2 className="text-sm font-semibold text-stone-900">Your referrals</h2>
          {referrals.isError ? (
            <QueryErrorState
              resource="your referrals"
              message={referrals.error.message}
              onRetry={() => referrals.refetch()}
              retrying={referrals.isRefetching}
            />
          ) : referrals.isLoading ? (
            <p className="mt-2 text-sm text-stone-500">Loading referrals…</p>
          ) : !referrals.data || referrals.data.referrals.length === 0 ? (
            <EmptyState
              title="No referrals yet"
              description="Share your code on WhatsApp to start earning referral bonuses."
            />
          ) : (
            <>
              <p className="mt-1 text-xs text-stone-400">
                {referrals.data.summary.total} total · {referrals.data.summary.successful}{" "}
                successful · {referrals.data.summary.pending} pending
              </p>
              <ul className="mt-3 divide-y divide-stone-100 rounded-2xl border border-stone-200 bg-white">
                {referrals.data.referrals.map((referral) => (
                  <li key={referral.id} className="flex items-center justify-between px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-stone-900">
                        {referral.referredName ?? "Pending signup"}
                      </p>
                      <p className="text-xs text-stone-400">
                        invited {formatDate(referral.createdAt)}
                      </p>
                    </div>
                    <div className="text-right">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          referral.status === "rewarded"
                            ? "bg-green-100 text-green-800"
                            : referral.status === "pending"
                              ? "bg-amber-100 text-amber-800"
                              : "bg-stone-100 text-stone-600"
                        }`}
                      >
                        {referral.status}
                      </span>
                      <p className="mt-1 text-xs text-stone-400">
                        +{referral.referrerBonusPoints} pts on reward
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section>
          <div className="flex items-center gap-2">
            <Gift className="h-4 w-4 text-amber-700" />
            <h2 className="text-sm font-semibold text-stone-900">Rewards catalog</h2>
          </div>
          {rewards.isError ? (
            <QueryErrorState
              resource="the rewards catalog"
              message={rewards.error.message}
              onRetry={() => rewards.refetch()}
              retrying={rewards.isRefetching}
            />
          ) : rewards.isLoading ? (
            <p className="mt-2 text-sm text-stone-500">Loading rewards…</p>
          ) : !rewards.data || rewards.data.length === 0 ? (
            <EmptyState title="No active rewards" description="Check back after the next campaign." />
          ) : (
            <ul className="mt-3 grid gap-3 sm:grid-cols-2">
              {rewards.data.map((reward) => (
                <li key={reward.id} className="rounded-2xl border border-stone-200 bg-white p-4">
                  <p className="text-sm font-medium text-stone-900">{reward.rewardName}</p>
                  {reward.description ? (
                    <p className="mt-1 text-xs leading-5 text-stone-500">{reward.description}</p>
                  ) : null}
                  <p className="mt-2 text-xs text-stone-400">
                    {reward.pointsCost.toLocaleString()} pts
                    {reward.minTier ? ` · ${reward.minTier}+ tier` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <div className="flex items-center gap-2">
            <Megaphone className="h-4 w-4 text-amber-700" />
            <h2 className="text-sm font-semibold text-stone-900">Active campaigns</h2>
          </div>
          {campaigns.isError ? (
            <QueryErrorState
              resource="active campaigns"
              message={campaigns.error.message}
              onRetry={() => campaigns.refetch()}
              retrying={campaigns.isRefetching}
            />
          ) : campaigns.isLoading ? (
            <p className="mt-2 text-sm text-stone-500">Loading campaigns…</p>
          ) : !campaigns.data || campaigns.data.length === 0 ? (
            <EmptyState
              title="No active campaigns"
              description="Promotions will appear here while they are running."
            />
          ) : (
            <ul className="mt-3 space-y-2">
              {campaigns.data.map((campaign) => (
                <li
                  key={campaign.id}
                  className="flex items-center justify-between rounded-2xl border border-stone-200 bg-white px-4 py-3"
                >
                  <div>
                    <p className="text-sm font-medium text-stone-900">{campaign.campaignName}</p>
                    <p className="text-xs text-stone-400">
                      {campaign.campaignType} via {campaign.channel}
                    </p>
                  </div>
                  <p className="text-xs text-stone-400">
                    {formatDate(campaign.startsAt)} – {formatDate(campaign.endsAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </ConsumerLayout>
  );
}
