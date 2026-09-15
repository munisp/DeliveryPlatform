import { FormEvent, useState } from "react";
import { BadgeCheck, Plus, ShieldAlert, Trash2, UsersRound } from "lucide-react";

import {
  type ManifestPassengerInput,
  useAttachManifest,
  useEconomicsSafetyInvalidation,
} from "@/lib/trpcEconomicsSafety";

const inputClass =
  "rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100";

/**
 * "Who's riding?" passenger manifest composer (R2 — every rider on a trip is
 * named, optionally NIN-verified, before dispatch). Embedded into the rider
 * booking surface; reusable wherever trip requests are created.
 */
export default function PassengerManifestForm({
  tripId: initialTripId = "",
}: {
  tripId?: string;
}) {
  const [tripId, setTripId] = useState(initialTripId);
  const [passengers, setPassengers] = useState<ManifestPassengerInput[]>([
    { name: "", nin: "" },
  ]);
  const attachManifest = useAttachManifest();
  const invalidation = useEconomicsSafetyInvalidation();

  const updatePassenger = (
    index: number,
    patch: Partial<ManifestPassengerInput>,
  ) =>
    setPassengers((current) =>
      current.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row,
      ),
    );

  const removePassenger = (index: number) =>
    setPassengers((current) =>
      current.length === 1
        ? current
        : current.filter((_, rowIndex) => rowIndex !== index),
    );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleaned = passengers
      .map((row) => ({
        name: row.name.trim(),
        nin: row.nin?.trim() ? row.nin.trim() : undefined,
      }))
      .filter((row) => row.name.length > 0);
    if (!tripId.trim() || cleaned.length === 0) return;
    attachManifest.mutate(
      { tripId: tripId.trim(), passengers: cleaned },
      { onSuccess: () => invalidation.safety() },
    );
  };

  const result = attachManifest.data;

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
        <UsersRound className="h-4 w-4 text-cyan-300" />
        Who&apos;s riding?
      </div>
      <input
        value={tripId}
        onChange={(event) => setTripId(event.target.value)}
        placeholder="Trip ID"
        className={`${inputClass} w-full`}
        required
      />
      {passengers.map((row, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <input
            value={row.name}
            onChange={(event) =>
              updatePassenger(index, { name: event.target.value })
            }
            placeholder={`Passenger ${index + 1} full name`}
            className={`${inputClass} min-w-40 flex-1`}
            required
          />
          <input
            value={row.nin ?? ""}
            onChange={(event) =>
              updatePassenger(index, { nin: event.target.value })
            }
            placeholder="NIN (optional)"
            inputMode="numeric"
            className={`${inputClass} min-w-32 flex-1`}
          />
          <button
            type="button"
            aria-label={`Remove passenger ${index + 1}`}
            onClick={() => removePassenger(index)}
            disabled={passengers.length === 1}
            className="rounded-md border border-slate-700 p-2 text-slate-400 hover:bg-slate-800 disabled:opacity-40"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() =>
            setPassengers((current) => [...current, { name: "", nin: "" }])
          }
          className="flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          <Plus className="h-4 w-4" />
          Add passenger
        </button>
        <button
          type="submit"
          disabled={attachManifest.isPending || !tripId.trim()}
          className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
        >
          {attachManifest.isPending ? "Attaching…" : "Attach manifest"}
        </button>
      </div>
      {attachManifest.isError ? (
        <p className="flex items-center gap-2 text-sm text-rose-200">
          <ShieldAlert className="h-4 w-4" />
          {attachManifest.error?.message ?? "Manifest could not be attached."}
        </p>
      ) : null}
      {result ? (
        <p
          className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
            result.manifestVerified
              ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-200"
              : "border-amber-400/40 bg-amber-500/10 text-amber-200"
          }`}
        >
          {result.manifestVerified ? (
            <>
              <BadgeCheck className="h-4 w-4" />
              Manifest verified — all named riders cleared screening.
            </>
          ) : (
            <>
              <ShieldAlert className="h-4 w-4" />
              Manifest attached but not fully verified — the driver will see
              per-rider verification chips before pickup.
            </>
          )}
        </p>
      ) : null}
    </form>
  );
}
