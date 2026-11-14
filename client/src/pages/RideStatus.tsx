import { useState } from "react";
import { Link, useParams } from "wouter";
import { ArrowLeft, CircleDot, Star } from "lucide-react";

import { ConsumerLayout } from "@/components/ConsumerLayout";
import { QueryErrorState } from "@/components/QueryState";
import { trpc } from "@/lib/trpc";
import {
  formatRideFare,
  generateRideActionKey,
  isRideTerminalState,
  normalizeRideTripDetail,
  rideStateLabel,
} from "@/lib/rideWire";

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Rating prompt for completed rides (P3-R). One rating per trip — the
 * server enforces UNIQUE(trip_id, author_user_id) and surfaces
 * trip_already_rated, which renders as a friendly confirmation.
 */
function RideRatingPanel({ tripId }: { tripId: string }) {
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState("");
  const [done, setDone] = useState<"rated" | "already" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const rate = trpc.consumerRide.rateTrip.useMutation({
    onSuccess: (result) => {
      setDone(result.replayed ? "already" : "rated");
      setErrorMessage(null);
    },
    onError: (error) => {
      if (error.message.includes("trip_already_rated")) {
        setDone("already");
        setErrorMessage(null);
      } else {
        setErrorMessage(error.message);
      }
    },
  });

  if (done) {
    return (
      <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
        {done === "already"
          ? "You have already rated this trip — thank you."
          : "Thanks for rating your driver."}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div
        className="flex items-center gap-1"
        role="radiogroup"
        aria-label="Trip rating"
      >
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
        maxLength={1000}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder="Optional comment about the trip"
        className="w-full rounded-xl border border-stone-200 px-4 py-3 text-sm outline-none focus:border-amber-500"
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
            tripId,
            score: stars,
            tags: [],
            comment: comment.trim() === "" ? undefined : comment.trim(),
            idempotencyKey: generateRideActionKey("rate", tripId),
          })
        }
        className="rounded-full bg-amber-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {rate.isPending ? "Submitting…" : "Submit rating"}
      </button>
    </div>
  );
}

/**
 * /ride/:tripId — live trip status. Polls consumerRide.myRideTrip every 4s
 * until a terminal state; rider actions: cancel (pre-pickup states) and
 * complete (in_progress) via consumerRide.transitionRide with
 * idempotency-keyed mutations; rating prompt on completed trips.
 */
export default function RideStatus() {
  const params = useParams<{ tripId: string }>();
  const tripId = params.tripId ?? "";
  const validId = UUID_RE.test(tripId);
  const [actionError, setActionError] = useState<string | null>(null);

  const detail = trpc.consumerRide.myRideTrip.useQuery(
    { tripId },
    {
      enabled: validId,
      refetchInterval: (query) => {
        const data = normalizeRideTripDetail(query.state.data);
        return data && isRideTerminalState(data.trip.state) ? false : 4000;
      },
    },
  );
  const ride = normalizeRideTripDetail(detail.data);

  const transition = trpc.consumerRide.transitionRide.useMutation({
    onSuccess: () => {
      setActionError(null);
      detail.refetch();
    },
    onError: (error) => setActionError(error.message),
  });

  const cancellable = ride
    ? ["requested", "matching", "driver_offered", "driver_reserved"].includes(
        ride.trip.state,
      )
    : false;
  const completable = ride?.trip.state === "in_progress";

  return (
    <ConsumerLayout
      title="Trip status"
      description="Live status of your ride request."
    >
      <div className="mb-6">
        <Link href="/ride">
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-800 hover:text-amber-900">
            <ArrowLeft className="h-4 w-4" />
            Back to rides
          </span>
        </Link>
      </div>

      {!validId ? (
        <QueryErrorState
          resource="this trip"
          message="The trip reference in the URL is not valid."
          onRetry={() => window.location.assign("/ride")}
        />
      ) : detail.isError ? (
        <QueryErrorState
          resource="this trip"
          message={detail.error.message}
          onRetry={() => detail.refetch()}
          retrying={detail.isRefetching}
        />
      ) : detail.isLoading || !ride ? (
        <p className="text-sm text-stone-500">Loading trip…</p>
      ) : (
        <div className="space-y-8">
          <section className="rounded-2xl border border-stone-200 bg-white p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-sm text-stone-500">
                  {ride.trip.pickupAddress} → {ride.trip.destinationAddress}
                </p>
                <p className="mt-1 text-xl font-semibold text-stone-900">
                  {rideStateLabel(ride.trip.state)}
                </p>
                {ride.trip.assignedDriverUserId !== null ? (
                  <p className="mt-1 text-sm text-stone-500">
                    Driver assigned
                  </p>
                ) : null}
              </div>
              {ride.quote ? (
                <div className="text-right">
                  <p className="text-sm text-stone-500">Fare</p>
                  <p className="text-xl font-semibold text-stone-900">
                    {formatRideFare(ride.quote.totalKobo)}
                  </p>
                </div>
              ) : null}
            </div>

            {ride.paymentReference ? (
              <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-stone-700">
                Payment reference:{" "}
                <span className="font-mono">{ride.paymentReference}</span>
              </p>
            ) : null}

            {actionError ? (
              <p
                className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
                role="alert"
              >
                {actionError}
              </p>
            ) : null}

            {cancellable || completable ? (
              <div className="mt-6 flex flex-wrap gap-3">
                {completable ? (
                  <button
                    type="button"
                    disabled={transition.isPending}
                    onClick={() =>
                      transition.mutate({
                        tripId: ride.trip.tripId,
                        action: "complete",
                        idempotencyKey: generateRideActionKey(
                          "complete",
                          ride.trip.tripId,
                        ),
                      })
                    }
                    className="rounded-full bg-amber-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {transition.isPending ? "Updating…" : "Complete trip"}
                  </button>
                ) : null}
                {cancellable ? (
                  <button
                    type="button"
                    disabled={transition.isPending}
                    onClick={() =>
                      transition.mutate({
                        tripId: ride.trip.tripId,
                        action: "cancel",
                        cancellationCode: "rider_cancelled",
                        idempotencyKey: generateRideActionKey(
                          "cancel",
                          ride.trip.tripId,
                        ),
                      })
                    }
                    className="rounded-full border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {transition.isPending ? "Updating…" : "Cancel ride"}
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>

          {ride.quote ? (
            <section className="rounded-2xl border border-stone-200 bg-white p-6">
              <h2 className="mb-4 text-base font-semibold text-stone-900">
                Fare breakdown
              </h2>
              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <dt className="text-stone-500">Base fare</dt>
                  <dd className="font-medium text-stone-900">
                    {formatRideFare(ride.quote.baseKobo)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-stone-500">
                    Distance ({(ride.quote.quotedDistanceM / 1000).toFixed(1)}{" "}
                    km)
                  </dt>
                  <dd className="font-medium text-stone-900">
                    {formatRideFare(ride.quote.distanceKobo)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-stone-500">
                    Time ({Math.round(ride.quote.quotedDurationS / 60)} min)
                  </dt>
                  <dd className="font-medium text-stone-900">
                    {formatRideFare(ride.quote.timeKobo)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-stone-500">Demand</dt>
                  <dd className="font-medium text-stone-900">
                    {formatRideFare(ride.quote.demandKobo)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-stone-500">Taxes & fees</dt>
                  <dd className="font-medium text-stone-900">
                    {formatRideFare(ride.quote.taxesAndFeesKobo)}
                  </dd>
                </div>
                {/* P7 flexible pricing modes: flat-fee / zero-commission
                    disclosure and subsidized driver-bonus badge. Additive
                    display only — money math is server-side. */}
                {ride.quote.pricingModel === "flat_fee" ||
                ride.quote.pricingModel === "zero_commission" ? (
                  <div className="flex justify-between gap-3">
                    <dt className="text-stone-500">Platform fee</dt>
                    <dd className="text-right font-medium text-stone-900">
                      {ride.quote.platformFeeKobo !== "0" ? (
                        <>
                          {formatRideFare(ride.quote.platformFeeKobo)}
                          <span className="block text-xs font-normal text-emerald-700">
                            {ride.quote.feePayer === "driver"
                              ? "Paid by your driver — 0% commission"
                              : "Your driver keeps 100% of the fare"}
                          </span>
                        </>
                      ) : (
                        <span className="text-xs font-normal text-emerald-700">
                          Zero commission — your driver keeps 100% of the fare
                        </span>
                      )}
                    </dd>
                  </div>
                ) : null}
                {ride.quote.pricingModel === "subsidized" ? (
                  <div className="flex justify-between">
                    <dt className="text-emerald-700">Driver bonus active</dt>
                    <dd className="text-xs font-medium text-emerald-700">
                      Subsidized fare
                    </dd>
                  </div>
                ) : null}
                <div className="flex justify-between border-t border-stone-100 pt-2">
                  <dt className="font-semibold text-stone-900">Total</dt>
                  <dd className="font-semibold text-stone-900">
                    {formatRideFare(ride.quote.totalKobo)}
                  </dd>
                </div>
              </dl>
            </section>
          ) : null}

          {ride.events.length > 0 ? (
            <section className="rounded-2xl border border-stone-200 bg-white p-6">
              <h2 className="mb-4 text-base font-semibold text-stone-900">
                Trip timeline
              </h2>
              <ol className="relative space-y-5 border-l border-stone-200 pl-6">
                {ride.events.map((event) => (
                  <li key={event.id}>
                    <span className="absolute -left-[7px] mt-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-100">
                      <CircleDot className="h-3 w-3 text-amber-700" />
                    </span>
                    <p className="text-sm font-medium text-stone-900">
                      {event.eventType.replace(/[._]/g, " ")}
                    </p>
                    <p className="text-xs text-stone-400">
                      {event.occurredAt
                        ? new Date(event.occurredAt).toLocaleString()
                        : ""}
                      {event.nextState
                        ? ` · ${rideStateLabel(event.nextState)}`
                        : ""}
                    </p>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {ride.trip.state === "completed" ||
          ride.trip.state === "completed_pending_payment" ? (
            <section className="rounded-2xl border border-stone-200 bg-white p-6">
              <h2 className="mb-4 text-base font-semibold text-stone-900">
                Rate this trip
              </h2>
              <RideRatingPanel tripId={ride.trip.tripId} />
            </section>
          ) : null}
        </div>
      )}
    </ConsumerLayout>
  );
}
