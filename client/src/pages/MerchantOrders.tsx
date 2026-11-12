import { useState } from "react";
import { ClipboardList } from "lucide-react";

import { EmptyState, QueryErrorState } from "@/components/QueryState";
import { trpc } from "@/lib/trpc";
import { MerchantSelfServeLayout } from "./MerchantSignup";

/**
 * /merchant-orders — merchant fulfillment inbox (P3-M).
 *
 * Lists commerce.fulfillment_request rows scoped to the caller's authorized
 * provider (merchantSelfServe.myFulfillmentRequests) with the merchant-legal
 * actions: accept / reject (requested only) and ready-for-pickup (accepted
 * only — recorded as evidence; driver assignment and dispatch stay with the
 * operator). Every action is idempotency-keyed and disabled-while-pending;
 * empty and error states are explicit (never fabricated zeros).
 */

const newKey = (scope: string) =>
  `${scope}-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

const stateStyles: Record<string, string> = {
  requested: "bg-amber-100 text-amber-800",
  accepted: "bg-orange-100 text-orange-800",
  assigned: "bg-orange-100 text-orange-800",
  out_for_delivery: "bg-amber-100 text-amber-800",
  delivered: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-stone-200 text-stone-500",
  failed: "bg-rose-100 text-rose-700",
};

function FulfillmentStateBadge({ state }: { state: string }) {
  const style = stateStyles[state] ?? "bg-stone-100 text-stone-700";
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}>
      {state.replace(/_/g, " ")}
    </span>
  );
}

type FulfillmentRequest = {
  id: string;
  providerId: number;
  medusaOrderId: string;
  state: string;
  deliveryOrderId: number | null;
  deliveryReference: string | null;
  failureReason: string | null;
  requestedAt: string;
  acceptedAt: string | null;
  updatedAt: string;
};

type FulfillmentStatus =
  | "requested"
  | "accepted"
  | "assigned"
  | "out_for_delivery"
  | "delivered"
  | "cancelled"
  | "failed";

const STATUS_FILTERS: Array<"" | FulfillmentStatus> = [
  "",
  "requested",
  "accepted",
  "assigned",
  "out_for_delivery",
  "delivered",
  "cancelled",
  "failed",
];

export default function MerchantOrders() {
  const utils = trpc.useUtils();
  const [providerId, setProviderId] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | FulfillmentStatus>("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const providerIdNumber = Number(providerId);
  const providerSelected = Number.isInteger(providerIdNumber) && providerIdNumber > 0;

  const requests = trpc.merchantSelfServe.myFulfillmentRequests.useQuery(
    {
      providerId: providerIdNumber,
      status: statusFilter === "" ? undefined : statusFilter,
      limit: 50,
    },
    { enabled: providerSelected, refetchOnWindowFocus: false },
  );

  const transition = trpc.merchantSelfServe.transitionMyFulfillment.useMutation({
    onSuccess: (result) => {
      setActionError(null);
      setRejectingId(null);
      setRejectReason("");
      setNotice(
        result.replayed
          ? "That action was already recorded — showing the current state."
          : result.previousState === result.state
            ? "Marked ready for pickup. The operator assigns a courier from here."
            : `Order ${result.previousState.replace(/_/g, " ")} → ${result.state.replace(/_/g, " ")}.`,
      );
      void utils.merchantSelfServe.myFulfillmentRequests.invalidate();
    },
    onError: (error) => {
      setNotice(null);
      setActionError(error.message);
    },
  });

  const act = (
    fulfillmentId: string,
    action: "accept" | "reject" | "ready",
    reason?: string,
  ) =>
    transition.mutate({
      fulfillmentId,
      action,
      reason,
      idempotencyKey: newKey(`merchant-fulfillment-${action}`),
    });

  const data = (requests.data ?? []) as FulfillmentRequest[];

  return (
    <MerchantSelfServeLayout
      title="Incoming orders"
      description="New orders from your storefront land here in real time. Accept or reject while an order is requested; mark it ready once prepared. Courier assignment and dispatch are handled by the platform."
    >
      <div className="mb-6 flex flex-wrap items-end gap-3">
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
        <label className="space-y-1 text-sm text-stone-700">
          Status
          <select
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(event.target.value as "" | FulfillmentStatus)
            }
            className="mt-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900"
          >
            {STATUS_FILTERS.map((status) => (
              <option key={status} value={status}>
                {status === "" ? "All" : status.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
      </div>

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

      {!providerSelected ? (
        <EmptyState
          title="Enter your provider ID"
          description="Your provider ID is shown after signup and in the merchant portal header."
        />
      ) : requests.isError ? (
        <QueryErrorState
          resource="incoming orders"
          message={requests.error.message}
          onRetry={() => requests.refetch()}
          retrying={requests.isRefetching}
        />
      ) : requests.isLoading ? (
        <p className="text-sm text-stone-500">Loading incoming orders…</p>
      ) : data.length === 0 ? (
        <EmptyState
          title="No orders in this view"
          description="When a customer places an order with your store it appears here for acceptance."
        />
      ) : (
        <ul className="divide-y divide-stone-200 rounded-2xl border border-stone-200 bg-white">
          {data.map((request) => (
            <li key={request.id} className="px-5 py-4">
              <div className="flex flex-wrap items-center gap-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-700">
                  <ClipboardList className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-stone-900">
                      Order {request.medusaOrderId}
                    </span>
                    <FulfillmentStateBadge state={request.state} />
                  </div>
                  <p className="mt-1 text-xs text-stone-400">
                    Requested {new Date(request.requestedAt).toLocaleString()}
                    {request.acceptedAt
                      ? ` · Accepted ${new Date(request.acceptedAt).toLocaleString()}`
                      : ""}
                    {request.deliveryReference
                      ? ` · Courier ref ${request.deliveryReference}`
                      : ""}
                    {request.failureReason ? ` · ${request.failureReason}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {request.state === "requested" ? (
                    <>
                      <button
                        type="button"
                        disabled={transition.isPending}
                        onClick={() => act(request.id, "accept")}
                        className="rounded-full bg-amber-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        disabled={transition.isPending}
                        onClick={() => {
                          setRejectingId(
                            rejectingId === request.id ? null : request.id,
                          );
                          setRejectReason("");
                        }}
                        className="rounded-full border border-rose-300 bg-rose-50 px-4 py-1.5 text-sm font-medium text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Reject
                      </button>
                    </>
                  ) : null}
                  {request.state === "accepted" ? (
                    <button
                      type="button"
                      disabled={transition.isPending}
                      onClick={() => act(request.id, "ready")}
                      className="rounded-full bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Ready for pickup
                    </button>
                  ) : null}
                </div>
              </div>
              {rejectingId === request.id ? (
                <form
                  className="mt-3 flex flex-wrap items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    act(request.id, "reject", rejectReason || "Rejected by merchant");
                  }}
                >
                  <input
                    value={rejectReason}
                    onChange={(event) => setRejectReason(event.target.value)}
                    placeholder="Reason (e.g. out of stock)"
                    maxLength={1000}
                    className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-900"
                  />
                  <button
                    type="submit"
                    disabled={transition.isPending}
                    className="rounded-full bg-rose-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Confirm rejection
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </MerchantSelfServeLayout>
  );
}
