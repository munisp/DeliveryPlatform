import { useState } from "react";
import { Link, useParams } from "wouter";
import { ArrowLeft, CircleDot, Star } from "lucide-react";

import { ConsumerLayout } from "@/components/ConsumerLayout";
import { EmptyState, QueryErrorState } from "@/components/QueryState";
import { trpc } from "@/lib/trpc";
import { normalizeTrackingEvents } from "@/lib/consumerWire";

import { formatMoney, OrderStatusBadge } from "./ConsumerOrders";

/**
 * Rating prompt for delivered orders (P2-A). One review per order — the
 * server enforces UNIQUE(order_id) on driver_reviews and raises
 * order_already_rated on a repeat, which is rendered as a friendly
 * confirmation instead of an error. rateOrder requires all five rating
 * dimensions; the single star selection is applied to each.
 */
function OrderRatingPanel({ orderId }: { orderId: number }) {
  const [stars, setStars] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [alreadyRated, setAlreadyRated] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const rate = trpc.consumer.rateOrder.useMutation({
    onSuccess: () => {
      setSubmitted(true);
      setErrorMessage(null);
    },
    onError: (error) => {
      if (error.message.includes("order_already_rated")) {
        setAlreadyRated(true);
        setErrorMessage(null);
      } else {
        setErrorMessage(error.message);
      }
    },
  });

  if (submitted || alreadyRated) {
    return (
      <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
        {alreadyRated
          ? "You have already rated this order — thank you."
          : "Thanks for rating your courier."}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={stars === value}
            aria-label={`${value} star${value === 1 ? "" : "s"}`}
            onClick={() => setStars(value)}
            className="rounded-full p-1 transition hover:bg-amber-50"
          >
            <Star
              className={`h-6 w-6 ${
                value <= stars
                  ? "fill-amber-400 text-amber-500"
                  : "text-stone-300"
              }`}
            />
          </button>
        ))}
      </div>
      <textarea
        rows={2}
        maxLength={2000}
        value={feedback}
        onChange={(event) => setFeedback(event.target.value)}
        placeholder="Optional feedback about the delivery"
        className="w-full rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-900 outline-none transition focus:border-amber-500"
      />
      {errorMessage ? (
        <p
          className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
          role="alert"
        >
          {errorMessage}
        </p>
      ) : null}
      <button
        type="button"
        disabled={rate.isPending || stars === 0}
        onClick={() =>
          rate.mutate({
            orderId,
            overallRating: stars,
            punctualityRating: stars,
            professionalismRating: stars,
            vehicleConditionRating: stars,
            communicationRating: stars,
            feedback: feedback.trim() === "" ? undefined : feedback.trim(),
          })
        }
        className="rounded-full bg-amber-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {rate.isPending ? "Submitting…" : "Submit rating"}
      </button>
    </div>
  );
}

export default function ConsumerOrderDetail() {
  const params = useParams<{ orderId: string }>();
  const orderId = Number(params.orderId);
  const validId = Number.isSafeInteger(orderId) && orderId > 0;

  const detail = trpc.consumer.myOrderDetail.useQuery(
    { orderId },
    { enabled: validId },
  );

  // Read-only delivery tracking feed (order_tracking_events), scoped
  // server-side to the caller's own orders. When no tracking events exist,
  // the synthesized Timeline section below remains the fallback render.
  const tracking = trpc.consumerCatalog.consumerOrderTracking.useQuery(
    { orderId },
    { enabled: validId },
  );
  const trackingEvents = normalizeTrackingEvents(tracking.data);

  return (
    <ConsumerLayout
      title="Order detail"
      description="Status timeline, payment ledger, and support cases for this order."
    >
      <div className="mb-6">
        <Link href="/account/orders">
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-800 hover:text-amber-900">
            <ArrowLeft className="h-4 w-4" />
            Back to orders
          </span>
        </Link>
      </div>

      {!validId ? (
        <QueryErrorState
          resource="this order"
          message="The order reference in the URL is not valid."
          onRetry={() => window.location.assign("/account/orders")}
        />
      ) : detail.isError ? (
        <QueryErrorState
          resource="this order"
          message={detail.error.message}
          onRetry={() => detail.refetch()}
          retrying={detail.isRefetching}
        />
      ) : detail.isLoading ? (
        <p className="text-sm text-stone-500">Loading order…</p>
      ) : !detail.data ? (
        <EmptyState
          title="Order not found"
          description="This order does not exist or does not belong to your account."
        />
      ) : (
        <div className="space-y-8">
          <section className="rounded-2xl border border-stone-200 bg-white p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-sm text-stone-500">Order</p>
                <p className="text-xl font-semibold text-stone-900">
                  {detail.data.order.orderNumber}
                </p>
                <div className="mt-2">
                  <OrderStatusBadge status={detail.data.order.status} />
                </div>
              </div>
              <div className="text-right">
                <p className="text-sm text-stone-500">Total</p>
                <p className="text-xl font-semibold text-stone-900">
                  {formatMoney(
                    detail.data.order.totalAmount,
                    detail.data.order.currency,
                  )}
                </p>
              </div>
            </div>
            <dl className="mt-6 grid gap-4 text-sm sm:grid-cols-2">
              {detail.data.order.providerName ? (
                <div>
                  <dt className="text-stone-400">Merchant</dt>
                  <dd className="text-stone-800">
                    {detail.data.order.providerName}
                  </dd>
                </div>
              ) : null}
              {detail.data.order.driverName ? (
                <div>
                  <dt className="text-stone-400">Courier</dt>
                  <dd className="text-stone-800">
                    {detail.data.order.driverName}
                  </dd>
                </div>
              ) : null}
              {detail.data.order.pickupAddress ? (
                <div>
                  <dt className="text-stone-400">Pickup</dt>
                  <dd className="text-stone-800">
                    {detail.data.order.pickupAddress}
                  </dd>
                </div>
              ) : null}
              {detail.data.order.deliveryAddress ? (
                <div>
                  <dt className="text-stone-400">Delivery</dt>
                  <dd className="text-stone-800">
                    {detail.data.order.deliveryAddress}
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>

          {trackingEvents.length > 0 ? (
            <section className="rounded-2xl border border-stone-200 bg-white p-6">
              <h2 className="mb-4 text-base font-semibold text-stone-900">
                Delivery tracking
              </h2>
              <ol className="relative space-y-5 border-l border-stone-200 pl-6">
                {trackingEvents.map((event) => (
                  <li key={event.id}>
                    <span className="absolute -left-[7px] mt-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-100">
                      <CircleDot className="h-3 w-3 text-amber-700" />
                    </span>
                    <p className="text-sm font-medium text-stone-900">
                      {event.statusLabel}
                    </p>
                    <p className="text-xs text-stone-400">
                      {event.eventTime
                        ? new Date(event.eventTime).toLocaleString()
                        : ""}
                      {event.etaMinutes !== null
                        ? ` · ETA ${event.etaMinutes} min`
                        : ""}
                    </p>
                    {event.eventType ? (
                      <p className="mt-0.5 text-xs text-stone-400">
                        {event.eventType.replace(/_/g, " ")}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {detail.data.order.status === "delivered" ? (
            <section className="rounded-2xl border border-stone-200 bg-white p-6">
              <h2 className="mb-4 text-base font-semibold text-stone-900">
                Rate this delivery
              </h2>
              <OrderRatingPanel orderId={detail.data.order.id} />
            </section>
          ) : null}

          <section className="rounded-2xl border border-stone-200 bg-white p-6">
            <h2 className="mb-4 text-base font-semibold text-stone-900">
              Timeline
            </h2>
            {detail.data.timeline.length === 0 ? (
              <EmptyState
                title="No events yet"
                description="Order events will appear here as they are recorded."
              />
            ) : (
              <ol className="relative space-y-5 border-l border-stone-200 pl-6">
                {detail.data.timeline.map((event, index) => (
                  <li key={`${event.kind}-${event.occurredAt}-${index}`}>
                    <span className="absolute -left-[7px] mt-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-100">
                      <CircleDot className="h-3 w-3 text-amber-700" />
                    </span>
                    <p className="text-sm font-medium text-stone-900">
                      {event.label}
                    </p>
                    <p className="text-xs text-stone-400">
                      {new Date(event.occurredAt).toLocaleString()}
                    </p>
                    {event.detail ? (
                      <p className="mt-0.5 text-sm text-stone-500">
                        {event.detail}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="rounded-2xl border border-stone-200 bg-white p-6">
            <h2 className="mb-4 text-base font-semibold text-stone-900">
              Payments & refunds
            </h2>
            {detail.data.ledger.length === 0 ? (
              <EmptyState
                title="No payment records yet"
                description="Payment and refund records for this order will appear here once they post."
              />
            ) : (
              <ul className="divide-y divide-stone-100">
                {detail.data.ledger.map((entry) => (
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
                        {entry.paymentMethod
                          ? ` · ${entry.paymentMethod}`
                          : ""}
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
                    <p className="font-semibold text-stone-900">
                      {formatMoney(entry.amount, entry.currency)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-2xl border border-stone-200 bg-white p-6">
            <div className="mb-4 flex items-center justify-between gap-4">
              <h2 className="text-base font-semibold text-stone-900">
                Support cases
              </h2>
              <Link href={`/account/support?orderId=${detail.data.order.id}`}>
                <span className="rounded-full bg-amber-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-amber-800">
                  Open a dispute
                </span>
              </Link>
            </div>
            {detail.data.supportCases.length === 0 ? (
              <EmptyState
                title="No support cases"
                description="If something went wrong with this order, open a dispute and it will be tracked here."
              />
            ) : (
              <ul className="divide-y divide-stone-100">
                {detail.data.supportCases.map((c) => (
                  <li key={c.id} className="py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium text-stone-800">{c.subject}</p>
                      <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600">
                        {c.status.replace(/_/g, " ")}
                      </span>
                    </div>
                    <p className="text-xs text-stone-400">
                      {c.ticketNumber} · opened{" "}
                      {new Date(c.createdAt).toLocaleString()}
                      {c.resolvedAt
                        ? ` · resolved ${new Date(c.resolvedAt).toLocaleString()}`
                        : ""}
                    </p>
                    {c.resolution ? (
                      <p className="mt-1 text-sm text-stone-500">
                        Resolution: {c.resolution}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </ConsumerLayout>
  );
}
