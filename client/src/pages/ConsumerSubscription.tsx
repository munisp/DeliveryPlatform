import { useState } from "react";
import { BadgeCheck, Crown } from "lucide-react";

import { ConsumerLayout } from "@/components/ConsumerLayout";
import { EmptyState, QueryErrorState } from "@/components/QueryState";
import { trpc } from "@/lib/trpc";
import {
  formatNairaMajor,
  generateConsumerIdempotencyKey,
  normalizeMembershipPlans,
  normalizeSubscription,
} from "@/lib/consumerWire";

/**
 * /account/subscription — membership plans, subscribe / cancel.
 *
 * Plans come from consumerCatalog.consumerPlans (active membership_plans,
 * major-unit price strings). The caller's latest subscription (any status)
 * comes from consumerCatalog.consumerMySubscription, so the current period
 * and the cancel action survive page reloads. Subscribe is
 * idempotency-keyed per (plan, attempt window); cancel uses the
 * subscription id returned by the read.
 */
export default function ConsumerSubscription() {
  const utils = trpc.useUtils();
  const plansQuery = trpc.consumerCatalog.consumerPlans.useQuery();
  const subscriptionQuery =
    trpc.consumerCatalog.consumerMySubscription.useQuery();

  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const plans = normalizeMembershipPlans(plansQuery.data);
  const subscription = normalizeSubscription(subscriptionQuery.data);
  const activeSubscription =
    subscription && subscription.status === "active" ? subscription : null;

  const subscribe = trpc.consumer.subscribePlan.useMutation({
    onSuccess: (result) => {
      setNotice(
        result.replayed
          ? "This subscription was already started — showing the existing one."
          : "Subscription started.",
      );
      setActionError(null);
      utils.consumerCatalog.consumerMySubscription.invalidate();
    },
    onError: (error) => {
      setNotice(null);
      setActionError(error.message);
    },
  });

  const cancel = trpc.consumer.cancelSubscription.useMutation({
    onSuccess: () => {
      setNotice("Subscription cancelled.");
      setActionError(null);
      utils.consumerCatalog.consumerMySubscription.invalidate();
    },
    onError: (error) => {
      setNotice(null);
      setActionError(error.message);
    },
  });

  const busy = subscribe.isPending || cancel.isPending;

  return (
    <ConsumerLayout
      title="Membership"
      description="Subscribe for delivery-fee discounts, cashback and priority support. Cancel anytime."
    >
      {actionError ? (
        <p
          className="mb-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
          role="alert"
        >
          {actionError}
        </p>
      ) : null}
      {notice ? (
        <p className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {notice}
        </p>
      ) : null}

      {subscriptionQuery.isError ? (
        <QueryErrorState
          resource="your subscription"
          message={subscriptionQuery.error.message}
          onRetry={() => subscriptionQuery.refetch()}
          retrying={subscriptionQuery.isRefetching}
        />
      ) : subscriptionQuery.isLoading ? (
        <p className="text-sm text-stone-500">Loading your membership…</p>
      ) : activeSubscription ? (
        <section className="mb-8 rounded-2xl border border-amber-200 bg-amber-50/60 p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="flex items-center gap-2 text-base font-semibold text-stone-900">
                <Crown className="h-4 w-4 text-amber-700" />
                Active membership —{" "}
                {plans.find((plan) => plan.id === activeSubscription.planId)
                  ?.planName ?? `Plan #${activeSubscription.planId}`}
              </p>
              <p className="mt-1 text-sm text-stone-500">
                Current period:{" "}
                {activeSubscription.currentPeriodStart
                  ? new Date(
                      activeSubscription.currentPeriodStart,
                    ).toLocaleDateString()
                  : "—"}{" "}
                →{" "}
                {activeSubscription.currentPeriodEnd
                  ? new Date(
                      activeSubscription.currentPeriodEnd,
                    ).toLocaleDateString()
                  : "—"}
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setNotice(null);
                cancel.mutate({ subscriptionId: activeSubscription.id });
              }}
              className="rounded-full border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {cancel.isPending ? "Cancelling…" : "Cancel subscription"}
            </button>
          </div>
        </section>
      ) : null}

      {plansQuery.isError ? (
        <QueryErrorState
          resource="membership plans"
          message={plansQuery.error.message}
          onRetry={() => plansQuery.refetch()}
          retrying={plansQuery.isRefetching}
        />
      ) : plansQuery.isLoading ? (
        <p className="text-sm text-stone-500">Loading plans…</p>
      ) : plans.length === 0 ? (
        <EmptyState
          title="No membership plans available"
          description="Membership plans will appear here once they are activated."
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {plans.map((plan) => {
            const isCurrent = activeSubscription?.planId === plan.id;
            return (
              <li
                key={plan.id}
                className="flex flex-col rounded-2xl border border-stone-200 bg-white p-6"
              >
                <p className="font-semibold text-stone-900">{plan.planName}</p>
                <p className="mt-1 text-2xl font-semibold text-stone-900">
                  {formatNairaMajor(plan.monthlyPriceMajor)}
                  <span className="text-sm font-normal text-stone-500">
                    {" "}
                    / month
                  </span>
                </p>
                <ul className="mt-3 space-y-1.5 text-sm text-stone-600">
                  <li className="flex items-center gap-2">
                    <BadgeCheck className="h-4 w-4 text-amber-700" />
                    {formatNairaMajor(plan.deliveryFeeDiscountMajor)} off
                    delivery fees
                  </li>
                  <li className="flex items-center gap-2">
                    <BadgeCheck className="h-4 w-4 text-amber-700" />
                    {plan.cashbackRateMajor}% cashback
                  </li>
                  {plan.prioritySupport ? (
                    <li className="flex items-center gap-2">
                      <BadgeCheck className="h-4 w-4 text-amber-700" />
                      Priority support
                    </li>
                  ) : null}
                  {plan.perks.map((perk, index) => (
                    <li key={index} className="flex items-center gap-2">
                      <BadgeCheck className="h-4 w-4 text-amber-700" />
                      {typeof perk === "string" ? perk : JSON.stringify(perk)}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  disabled={busy || isCurrent}
                  onClick={() => {
                    setNotice(null);
                    subscribe.mutate({
                      planId: plan.id,
                      idempotencyKey: generateConsumerIdempotencyKey(
                        "subscribe",
                        plan.id,
                      ),
                    });
                  }}
                  className="mt-5 rounded-full bg-amber-700 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isCurrent
                    ? "Current plan"
                    : subscribe.isPending
                      ? "Subscribing…"
                      : "Subscribe"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </ConsumerLayout>
  );
}
