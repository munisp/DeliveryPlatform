import { useState } from "react";
import { Link } from "wouter";
import { MapPin, Navigation } from "lucide-react";

import { ConsumerLayout } from "@/components/ConsumerLayout";
import { EmptyState, QueryErrorState } from "@/components/QueryState";
import { trpc } from "@/lib/trpc";
import {
  formatRideFare,
  generateRideActionKey,
  normalizeRideTrips,
  rideStateLabel,
} from "@/lib/rideWire";

/**
 * /ride — consumer ride-hailing home (P3-R). Request form (manual address +
 * lat/lng, same approved fallback as consumer checkout), recent trips from
 * consumerRide.myRideTrips. On success the rider is taken to the live trip
 * status page. The request is idempotency-keyed per attempt; retries with
 * the same key replay the stored trip server-side.
 */
export default function RideHome() {
  const [form, setForm] = useState({
    pickupAddress: "",
    pickupLat: "",
    pickupLng: "",
    destinationAddress: "",
    destinationLat: "",
    destinationLng: "",
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [requestKey, setRequestKey] = useState<string | null>(null);

  const tripsQuery = trpc.consumerRide.myRideTrips.useQuery({ limit: 10 });
  const trips = normalizeRideTrips(tripsQuery.data);

  const request = trpc.consumerRide.requestRide.useMutation({
    onSuccess: () => {
      tripsQuery.refetch();
    },
  });

  const update =
    (field: keyof typeof form) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setForm((current) => ({ ...current, [field]: event.target.value }));
    };

  const parseCoord = (value: string, min: number, max: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max
      ? parsed
      : null;
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const pickupLat = parseCoord(form.pickupLat, -90, 90);
    const pickupLng = parseCoord(form.pickupLng, -180, 180);
    const destinationLat = parseCoord(form.destinationLat, -90, 90);
    const destinationLng = parseCoord(form.destinationLng, -180, 180);
    if (
      pickupLat === null ||
      pickupLng === null ||
      destinationLat === null ||
      destinationLng === null
    ) {
      setFormError(
        "Enter valid coordinates (latitude -90…90, longitude -180…180).",
      );
      return;
    }
    if (
      form.pickupAddress.trim().length < 3 ||
      form.destinationAddress.trim().length < 3
    ) {
      setFormError("Enter both pickup and destination addresses.");
      return;
    }
    const key = requestKey ?? generateRideActionKey("request", "trip");
    request.mutate(
      {
        pickupLat,
        pickupLng,
        pickupAddress: form.pickupAddress.trim(),
        destinationLat,
        destinationLng,
        destinationAddress: form.destinationAddress.trim(),
        idempotencyKey: key,
      },
      {
        onSuccess: (result) => {
          setRequestKey(null);
          window.location.assign(`/ride/${result.tripId}`);
        },
        onError: () => {
          // Keep the same key so an immediate retry replays server-side.
          setRequestKey(key);
        },
      },
    );
  };

  return (
    <ConsumerLayout
      title="Rides"
      description="Request a ride across active Lagos dispatch zones. Fares are quoted in exact naira before you confirm."
    >
      <div className="grid gap-8 lg:grid-cols-2">
        <section className="rounded-2xl border border-stone-200 bg-white p-6">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold text-stone-900">
            <Navigation className="h-4 w-4 text-amber-700" />
            Request a ride
          </h2>
          <form className="space-y-4" onSubmit={submit}>
            <div>
              <label className="text-sm font-medium text-stone-700">
                Pickup address
              </label>
              <input
                required
                value={form.pickupAddress}
                onChange={update("pickupAddress")}
                placeholder="Street address or landmark"
                className="mt-1 w-full rounded-xl border border-stone-200 px-4 py-2.5 text-sm outline-none focus:border-amber-500"
              />
              <div className="mt-2 grid grid-cols-2 gap-2">
                <input
                  required
                  inputMode="decimal"
                  value={form.pickupLat}
                  onChange={update("pickupLat")}
                  placeholder="Latitude (e.g. 6.5244)"
                  className="rounded-xl border border-stone-200 px-3 py-2 text-sm outline-none focus:border-amber-500"
                />
                <input
                  required
                  inputMode="decimal"
                  value={form.pickupLng}
                  onChange={update("pickupLng")}
                  placeholder="Longitude (e.g. 3.3792)"
                  className="rounded-xl border border-stone-200 px-3 py-2 text-sm outline-none focus:border-amber-500"
                />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium text-stone-700">
                Destination address
              </label>
              <input
                required
                value={form.destinationAddress}
                onChange={update("destinationAddress")}
                placeholder="Where are you going?"
                className="mt-1 w-full rounded-xl border border-stone-200 px-4 py-2.5 text-sm outline-none focus:border-amber-500"
              />
              <div className="mt-2 grid grid-cols-2 gap-2">
                <input
                  required
                  inputMode="decimal"
                  value={form.destinationLat}
                  onChange={update("destinationLat")}
                  placeholder="Latitude"
                  className="rounded-xl border border-stone-200 px-3 py-2 text-sm outline-none focus:border-amber-500"
                />
                <input
                  required
                  inputMode="decimal"
                  value={form.destinationLng}
                  onChange={update("destinationLng")}
                  placeholder="Longitude"
                  className="rounded-xl border border-stone-200 px-3 py-2 text-sm outline-none focus:border-amber-500"
                />
              </div>
            </div>
            {formError ? (
              <p
                className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
                role="alert"
              >
                {formError}
              </p>
            ) : null}
            {request.isError ? (
              <p
                className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
                role="alert"
              >
                {request.error.message.includes("ride_zone_unavailable")
                  ? "This pickup is outside our active Lagos dispatch zones."
                  : request.error.message}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={request.isPending}
              className="w-full rounded-full bg-amber-700 px-5 py-3 text-sm font-medium text-white transition hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {request.isPending ? "Requesting…" : "Request ride"}
            </button>
          </form>
        </section>

        <section className="rounded-2xl border border-stone-200 bg-white p-6">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold text-stone-900">
            <MapPin className="h-4 w-4 text-amber-700" />
            Your trips
          </h2>
          {tripsQuery.isError ? (
            <QueryErrorState
              resource="your trips"
              message={tripsQuery.error.message}
              onRetry={() => tripsQuery.refetch()}
              retrying={tripsQuery.isRefetching}
            />
          ) : tripsQuery.isLoading ? (
            <p className="text-sm text-stone-500">Loading trips…</p>
          ) : trips.length === 0 ? (
            <EmptyState
              title="No trips yet"
              description="Request your first ride and it will appear here with live status."
            />
          ) : (
            <ul className="divide-y divide-stone-100">
              {trips.map((trip) => (
                <li key={trip.tripId} className="py-3">
                  <Link href={`/ride/${trip.tripId}`}>
                    <span className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-stone-900">
                          {trip.pickupAddress} → {trip.destinationAddress}
                        </span>
                        <span className="text-xs text-stone-400">
                          {trip.requestedAt
                            ? new Date(trip.requestedAt).toLocaleString()
                            : ""}
                        </span>
                      </span>
                      <span className="shrink-0 rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-700">
                        {rideStateLabel(trip.state)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </ConsumerLayout>
  );
}
