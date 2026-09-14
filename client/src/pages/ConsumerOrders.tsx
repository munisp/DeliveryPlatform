import { Link } from "wouter";
import { ChevronRight, Package } from "lucide-react";

import { ConsumerLayout } from "@/components/ConsumerLayout";
import { EmptyState, QueryErrorState } from "@/components/QueryState";
import { trpc } from "@/lib/trpc";

const statusStyles: Record<string, string> = {
  pending: "bg-stone-100 text-stone-700",
  confirmed: "bg-amber-100 text-amber-800",
  assigned: "bg-amber-100 text-amber-800",
  picked_up: "bg-orange-100 text-orange-800",
  in_transit: "bg-orange-100 text-orange-800",
  delivered: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-stone-200 text-stone-500",
  refunded: "bg-rose-100 text-rose-700",
};

export function formatMoney(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function OrderStatusBadge({ status }: { status: string }) {
  const style = statusStyles[status] ?? "bg-stone-100 text-stone-700";
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

export default function ConsumerOrders() {
  const orders = trpc.consumer.myOrders.useQuery({ limit: 50 });

  return (
    <ConsumerLayout
      title="Your orders"
      description="Live status for every order placed with this account, read directly from the orders ledger."
    >
      {orders.isError ? (
        <QueryErrorState
          resource="your orders"
          message={orders.error.message}
          onRetry={() => orders.refetch()}
          retrying={orders.isRefetching}
        />
      ) : orders.isLoading ? (
        <p className="text-sm text-stone-500">Loading your orders…</p>
      ) : !orders.data || orders.data.length === 0 ? (
        <EmptyState
          title="No orders yet"
          description="When you place an order it will appear here with live status, courier assignment, and delivery timing."
        />
      ) : (
        <ul className="divide-y divide-stone-200 rounded-2xl border border-stone-200 bg-white">
          {orders.data.map((order) => (
            <li key={order.id}>
              <Link href={`/account/orders/${order.id}`}>
                <span className="flex items-center gap-4 px-5 py-4 transition hover:bg-stone-50">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-700">
                    <Package className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-stone-900">
                        {order.orderNumber}
                      </span>
                      <OrderStatusBadge status={order.status} />
                      {order.openSupportCases > 0 ? (
                        <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">
                          {order.openSupportCases} open case
                          {order.openSupportCases === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-1 block truncate text-sm text-stone-500">
                      {[order.providerName, order.verticalName]
                        .filter(Boolean)
                        .join(" · ") || "Marketplace order"}
                      {order.deliveryAddress
                        ? ` — ${order.deliveryAddress}`
                        : ""}
                    </span>
                    <span className="mt-0.5 block text-xs text-stone-400">
                      Placed {new Date(order.createdAt).toLocaleString()}
                      {order.actualDeliveryTime
                        ? ` · Delivered ${new Date(order.actualDeliveryTime).toLocaleString()}`
                        : order.estimatedDeliveryTime
                          ? ` · ETA ${new Date(order.estimatedDeliveryTime).toLocaleString()}`
                          : ""}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block font-semibold text-stone-900">
                      {formatMoney(order.totalAmount, order.currency)}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-stone-300" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ConsumerLayout>
  );
}
