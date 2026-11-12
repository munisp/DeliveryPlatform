import { useState } from "react";

import { EmptyState, QueryErrorState } from "@/components/QueryState";
import { trpc } from "@/lib/trpc";
import { MerchantSelfServeLayout } from "./MerchantSignup";

/**
 * /merchant-earnings — read-only merchant earnings view (P3-M).
 *
 * Aggregates from merchantSelfServe.myEarnings: delivered-order gross (legacy
 * varchar major-unit sum), order counts, fulfillment pipeline counts, and
 * whether a settlement destination is configured. The payout reference itself
 * is never returned or rendered. Real settlement rows land in a later wave.
 */

function formatMajor(major: string, currency: string): string {
  const value = Number(major);
  if (!Number.isFinite(value)) return `${major} ${currency}`;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

type Earnings = {
  providerId: number;
  orderCount: number;
  deliveredOrderCount: number;
  grossDeliveredMajor: string;
  currency: string;
  fulfillmentsByState: Record<string, number>;
  payoutConfigured: boolean;
};

const STATE_LABELS: Record<string, string> = {
  requested: "Awaiting acceptance",
  accepted: "Being prepared",
  assigned: "Courier assigned",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
  failed: "Failed",
};

export default function MerchantEarnings() {
  const [providerId, setProviderId] = useState("");
  const providerIdNumber = Number(providerId);
  const providerSelected = Number.isInteger(providerIdNumber) && providerIdNumber > 0;

  const earnings = trpc.merchantSelfServe.myEarnings.useQuery(
    { providerId: providerIdNumber },
    { enabled: providerSelected, refetchOnWindowFocus: false },
  );
  const data = earnings.data as Earnings | undefined;

  return (
    <MerchantSelfServeLayout
      title="Earnings"
      description="Delivered-order gross and your fulfillment pipeline, read live from the ledger. Payout settlement rows land in a later wave."
    >
      <div className="mb-6">
        <label className="space-y-1 text-sm text-stone-700">
          Provider ID
          <input
            value={providerId}
            onChange={(event) => setProviderId(event.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
            placeholder="e.g. 42"
            className="mt-1 w-40 rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900"
          />
        </label>
      </div>

      {!providerSelected ? (
        <EmptyState
          title="Enter your provider ID"
          description="Your provider ID is shown after signup and in the merchant portal header."
        />
      ) : earnings.isError ? (
        <QueryErrorState
          resource="your earnings"
          message={earnings.error.message}
          onRetry={() => earnings.refetch()}
          retrying={earnings.isRefetching}
        />
      ) : earnings.isLoading ? (
        <p className="text-sm text-stone-500">Loading earnings…</p>
      ) : !data ? (
        <EmptyState title="No earnings data" />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-2xl border border-stone-200 bg-white p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">
                Delivered gross
              </p>
              <p className="mt-2 text-2xl font-semibold text-stone-900">
                {formatMajor(data.grossDeliveredMajor, data.currency)}
              </p>
              <p className="mt-1 text-xs text-stone-500">
                Across {data.deliveredOrderCount} delivered order
                {data.deliveredOrderCount === 1 ? "" : "s"} ({data.orderCount} total)
              </p>
            </div>
            <div className="rounded-2xl border border-stone-200 bg-white p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">
                Orders
              </p>
              <p className="mt-2 text-2xl font-semibold text-stone-900">
                {data.orderCount}
              </p>
              <p className="mt-1 text-xs text-stone-500">
                All statuses, attributed to this store
              </p>
            </div>
            <div className="rounded-2xl border border-stone-200 bg-white p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">
                Payout destination
              </p>
              <p className="mt-2">
                <span
                  className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    data.payoutConfigured
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-amber-100 text-amber-800"
                  }`}
                >
                  {data.payoutConfigured ? "Configured" : "Not configured"}
                </span>
              </p>
              <p className="mt-1 text-xs text-stone-500">
                {data.payoutConfigured
                  ? "A settlement destination is on file. Payouts land in a later wave."
                  : "Configure payments in the merchant portal to receive payouts."}
              </p>
            </div>
          </div>

          <section className="rounded-2xl border border-stone-200 bg-white p-5">
            <h2 className="text-base font-semibold text-stone-900">
              Fulfillment pipeline
            </h2>
            {Object.keys(data.fulfillmentsByState).length === 0 ? (
              <p className="mt-3 text-sm text-stone-500">
                No fulfillment requests yet — orders appear here once customers
                start ordering.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-stone-100">
                {Object.entries(data.fulfillmentsByState).map(([state, count]) => (
                  <li
                    key={state}
                    className="flex items-center justify-between py-2 text-sm"
                  >
                    <span className="text-stone-600">
                      {STATE_LABELS[state] ?? state.replace(/_/g, " ")}
                    </span>
                    <span className="font-medium text-stone-900">{count}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Figures are gross delivered-order totals. Commission breakdowns and
            actual payout settlement rows are delivered in a later wave.
          </p>
        </div>
      )}
    </MerchantSelfServeLayout>
  );
}
