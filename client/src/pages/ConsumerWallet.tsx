import { Link } from "wouter";
import { Star, Wallet } from "lucide-react";

import { ConsumerLayout } from "@/components/ConsumerLayout";
import { EmptyState, QueryErrorState } from "@/components/QueryState";
import { trpc } from "@/lib/trpc";

import { formatMoney } from "./ConsumerOrders";

export default function ConsumerWallet() {
  const wallet = trpc.consumer.myWallet.useQuery({ limit: 50 });

  return (
    <ConsumerLayout
      title="Wallet & activity"
      description="Your stored balance, payment and refund ledger, and loyalty points — read live from the platform ledger."
    >
      {wallet.isError ? (
        <QueryErrorState
          resource="your wallet"
          message={wallet.error.message}
          onRetry={() => wallet.refetch()}
          retrying={wallet.isRefetching}
        />
      ) : wallet.isLoading ? (
        <p className="text-sm text-stone-500">Loading your wallet…</p>
      ) : !wallet.data ? (
        <EmptyState
          title="No wallet data"
          description="No wallet or ledger data was returned for this account."
        />
      ) : (
        <div className="space-y-8">
          <section className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-stone-200 bg-white p-6">
              <div className="flex items-center gap-2 text-sm text-stone-500">
                <Wallet className="h-4 w-4 text-amber-700" />
                Stored balance
              </div>
              {wallet.data.wallet ? (
                <>
                  <p className="mt-2 text-3xl font-semibold text-stone-900">
                    {formatMoney(
                      wallet.data.wallet.balance,
                      wallet.data.wallet.currency,
                    )}
                  </p>
                  <p className="mt-1 text-xs text-stone-400">
                    {wallet.data.wallet.userType} wallet · updated{" "}
                    {new Date(wallet.data.wallet.updatedAt).toLocaleString()}
                  </p>
                </>
              ) : (
                <p className="mt-2 text-sm leading-6 text-stone-500">
                  No stored-balance wallet has been provisioned for this
                  account yet. Your full payment and refund ledger is shown
                  below.
                </p>
              )}
            </div>
            <div className="rounded-2xl border border-stone-200 bg-white p-6">
              <p className="text-sm text-stone-500">Ledger totals</p>
              <dl className="mt-2 space-y-1 text-sm">
                <div className="flex justify-between">
                  <dt className="text-stone-500">Completed payments</dt>
                  <dd className="font-semibold text-stone-900">
                    {formatMoney(
                      wallet.data.totals.paidTotal,
                      wallet.data.totals.currency,
                    )}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-stone-500">Completed refunds</dt>
                  <dd className="font-semibold text-stone-900">
                    {formatMoney(
                      wallet.data.totals.refundTotal,
                      wallet.data.totals.currency,
                    )}
                  </dd>
                </div>
              </dl>
              {wallet.data.loyalty ? (
                <div className="mt-4 border-t border-stone-100 pt-3">
                  <div className="flex items-center gap-2 text-sm text-stone-500">
                    <Star className="h-4 w-4 text-amber-600" />
                    Loyalty — {wallet.data.loyalty.tier} tier
                  </div>
                  <p className="mt-1 text-sm font-semibold text-stone-900">
                    {wallet.data.loyalty.pointsBalance.toLocaleString()} points
                    <span className="ml-2 font-normal text-stone-400">
                      ({wallet.data.loyalty.lifetimePoints.toLocaleString()}{" "}
                      lifetime)
                    </span>
                  </p>
                </div>
              ) : null}
            </div>
          </section>

          <section className="rounded-2xl border border-stone-200 bg-white p-6">
            <h2 className="mb-4 text-base font-semibold text-stone-900">
              Transaction ledger
            </h2>
            {wallet.data.ledger.length === 0 ? (
              <EmptyState
                title="No transactions yet"
                description="Payments and refunds for your orders will appear here once they post."
              />
            ) : (
              <ul className="divide-y divide-stone-100">
                {wallet.data.ledger.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
                  >
                    <div>
                      <p className="font-medium capitalize text-stone-800">
                        {entry.type}
                        <span className="ml-2 rounded-full bg-stone-100 px-2 py-0.5 text-xs font-normal text-stone-600">
                          {entry.status}
                        </span>
                      </p>
                      <p className="text-xs text-stone-400">
                        {new Date(entry.createdAt).toLocaleString()}
                        {entry.orderNumber && entry.orderId ? (
                          <>
                            {" · "}
                            <Link href={`/account/orders/${entry.orderId}`}>
                              <span className="text-amber-800 hover:text-amber-900">
                                {entry.orderNumber}
                              </span>
                            </Link>
                          </>
                        ) : null}
                        {entry.paymentMethod ? ` · ${entry.paymentMethod}` : ""}
                        {entry.transferState
                          ? ` · transfer ${entry.transferState}`
                          : ""}
                        {entry.refundState
                          ? ` · refund ${entry.refundState}${
                              entry.refundAmount !== null
                                ? ` ${formatMoney(entry.refundAmount, entry.currency)}`
                                : ""
                            }`
                          : ""}
                      </p>
                    </div>
                    <p
                      className={`font-semibold ${
                        entry.type === "refund"
                          ? "text-emerald-700"
                          : "text-stone-900"
                      }`}
                    >
                      {entry.type === "refund" ? "+" : "−"}
                      {formatMoney(entry.amount, entry.currency)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {wallet.data.loyalty && wallet.data.loyalty.recent.length > 0 ? (
            <section className="rounded-2xl border border-stone-200 bg-white p-6">
              <h2 className="mb-4 text-base font-semibold text-stone-900">
                Recent loyalty activity
              </h2>
              <ul className="divide-y divide-stone-100">
                {wallet.data.loyalty.recent.map((tx) => (
                  <li
                    key={tx.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
                  >
                    <div>
                      <p className="font-medium text-stone-800">
                        {tx.description ?? tx.transactionType.replace(/_/g, " ")}
                      </p>
                      <p className="text-xs text-stone-400">
                        {new Date(tx.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <p
                      className={`font-semibold ${
                        tx.points >= 0 ? "text-emerald-700" : "text-rose-700"
                      }`}
                    >
                      {tx.points >= 0 ? "+" : ""}
                      {tx.points.toLocaleString()} pts
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </ConsumerLayout>
  );
}
