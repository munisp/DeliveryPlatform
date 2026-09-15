import { useEffect, useRef, useState } from "react";
import {
  BadgeCheck,
  CircleAlert,
  Gavel,
  ShieldAlert,
  ShieldCheck,
  Siren,
  UserCheck,
  UsersRound,
  Wallet,
} from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import FareBreakdown, { formatMinor } from "@/components/FareBreakdown";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSessionProfile } from "@/lib/sessionProfile";
import {
  type SOSAlert,
  useActiveSOS,
  useCancelSOS,
  useEconomicsSafetyInvalidation,
  useManifest,
  useMyNetEarningsSummary,
  useMyOffers,
  useResolveSOS,
  useTriggerSOS,
} from "@/lib/trpcEconomicsSafety";

const operationsRoles = new Set([
  "operator",
  "ops",
  "admin",
  "platform_admin",
  "super_admin",
]);

const HOLD_TO_CONFIRM_MS = 3_000;

function passengerChip(verified: boolean) {
  return verified
    ? "inline-flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-500/10 px-3 py-1 text-sm text-emerald-200"
    : "inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-sm text-amber-200";
}

function SOSButton({ tripId }: { tripId: string }) {
  const triggerSOS = useTriggerSOS();
  const cancelSOS = useCancelSOS();
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const [activeSOS, setActiveSOS] = useState<SOSAlert | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);

  const clearHold = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (frameRef.current) clearInterval(frameRef.current);
    timerRef.current = null;
    frameRef.current = null;
    setHolding(false);
    setProgress(0);
  };

  useEffect(() => clearHold, []);

  const fire = () => {
    clearHold();
    const send = (coords?: { lat: number; lng: number }) =>
      triggerSOS.mutate({
        role: "driver",
        tripId: tripId || undefined,
        lat: coords?.lat,
        lng: coords?.lng,
      });
    if (typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) =>
          send({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          }),
        () => send(),
        { timeout: 2_000 },
      );
    } else {
      send();
    }
  };

  const onPointerDown = () => {
    if (triggerSOS.isPending || activeSOS) return;
    setHolding(true);
    startedAtRef.current = Date.now();
    frameRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current;
      setProgress(Math.min(1, elapsed / HOLD_TO_CONFIRM_MS));
    }, 50);
    timerRef.current = setTimeout(fire, HOLD_TO_CONFIRM_MS);
  };

  // Track the triggered SOS id from the settled mutation result.
  const triggeredId = triggerSOS.data?.id ?? null;
  useEffect(() => {
    if (triggeredId) setActiveSOS({ id: triggeredId, status: "active" });
  }, [triggeredId]);

  return (
    <div className="space-y-3">
      {activeSOS ? (
        <div className="space-y-3 rounded-md border border-rose-400/50 bg-rose-500/10 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-rose-200">
            <Siren className="h-5 w-5 animate-pulse" />
            SOS active — status: {activeSOS.status}
          </p>
          <p className="font-mono text-xs text-rose-200/70">{activeSOS.id}</p>
          <button
            type="button"
            onClick={() =>
              cancelSOS.mutate(
                { sosId: activeSOS.id },
                { onSuccess: () => setActiveSOS(null) },
              )
            }
            disabled={cancelSOS.isPending}
            className="rounded-md border border-rose-300/50 px-4 py-2 text-sm font-medium text-rose-100 hover:bg-rose-500/20 disabled:opacity-50"
          >
            {cancelSOS.isPending ? "Cancelling…" : "Cancel SOS — I am safe"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          aria-label="Hold for three seconds to trigger an SOS alert"
          onPointerDown={onPointerDown}
          onPointerUp={clearHold}
          onPointerLeave={clearHold}
          onPointerCancel={clearHold}
          disabled={triggerSOS.isPending}
          className="relative flex h-32 w-full items-center justify-center overflow-hidden rounded-xl border-2 border-rose-400/60 bg-rose-600/20 text-rose-100 transition-colors select-none hover:bg-rose-600/30 disabled:opacity-60"
        >
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 bg-rose-500/40"
            style={{ width: `${progress * 100}%` }}
          />
          <span className="relative flex flex-col items-center gap-1">
            <Siren className="h-8 w-8" />
            <span className="text-lg font-bold tracking-wide">
              {triggerSOS.isPending
                ? "Sending SOS…"
                : holding
                  ? "Keep holding…"
                  : "SOS — hold 3 seconds"}
            </span>
            <span className="text-xs text-rose-200/80">
              Alerts the safety desk with your location and trip
            </span>
          </span>
        </button>
      )}
      {triggerSOS.isError ? (
        <p className="flex items-center gap-2 text-sm text-rose-200">
          <CircleAlert className="h-4 w-4" />
          {triggerSOS.error?.message ?? "SOS could not be sent — try again."}
        </p>
      ) : null}
    </div>
  );
}

function ManifestPanel({ tripId }: { tripId: string }) {
  const manifest = useManifest(tripId);

  if (!tripId) {
    return (
      <p className="text-sm text-slate-500">
        Enter a trip ID above to load its passenger manifest before pickup.
      </p>
    );
  }
  if (manifest.isLoading) {
    return <p className="text-sm text-slate-400">Loading manifest…</p>;
  }
  if (manifest.isError || !manifest.data) {
    return (
      <p className="flex items-center gap-2 text-sm text-amber-200">
        <ShieldAlert className="h-4 w-4" />
        Manifest unavailable — {manifest.error?.message ?? "try again"}.
      </p>
    );
  }

  const passengers = manifest.data.passengers;
  const verifiedCount = passengers.filter((p) => p.verified).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={
            manifest.data.manifestVerified
              ? "inline-flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-500/10 px-3 py-1 text-sm text-emerald-200"
              : "inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-sm text-amber-200"
          }
        >
          {manifest.data.manifestVerified ? (
            <>
              <BadgeCheck className="h-4 w-4" /> Manifest verified
            </>
          ) : (
            <>
              <ShieldAlert className="h-4 w-4" /> Manifest unverified
            </>
          )}
        </span>
        <span className="text-sm text-slate-400">
          {verifiedCount} of {passengers.length} passenger
          {passengers.length === 1 ? "" : "s"} verified
        </span>
      </div>
      {passengers.length === 0 ? (
        <p className="text-sm text-slate-500">
          No passengers are attached to this trip yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {passengers.map((passenger, index) => (
            <li
              key={`${passenger.name}-${index}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-800 p-3"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-slate-100">
                <UserCheck className="h-4 w-4 text-cyan-300" />
                {passenger.name}
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <span className={passengerChip(passenger.verified)}>
                  {passenger.verified ? (
                    <>
                      <BadgeCheck className="h-4 w-4" /> Verified rider
                    </>
                  ) : (
                    <>
                      <ShieldAlert className="h-4 w-4" /> Unverified rider
                    </>
                  )}
                </span>
                {passenger.flags.map((flag) => (
                  <span
                    key={flag}
                    className="rounded-full border border-rose-400/40 bg-rose-500/10 px-2 py-0.5 text-xs text-rose-200"
                  >
                    {flag}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EarningsCard() {
  const summary = useMyNetEarningsSummary();
  const offers = useMyOffers();
  const latestOfferId = offers.data?.[0]?.offerId ?? "";

  return (
    <Card className="border-slate-800 bg-slate-950/60">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-slate-100">
          <Wallet className="h-5 w-5 text-cyan-300" />
          My net earnings — last 30 days
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {summary.isLoading ? (
          <p className="text-sm text-slate-400">Loading earnings summary…</p>
        ) : summary.isError || !summary.data ? (
          <p className="text-sm text-slate-500">
            Net earnings summary is unavailable right now.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-5">
            {[
              ["Trips", String(summary.data.trips30d)],
              [
                "Gross",
                formatMinor(summary.data.grossMinor, summary.data.currency),
              ],
              [
                "Deadhead credited",
                formatMinor(
                  summary.data.deadheadMinor,
                  summary.data.currency,
                ),
              ],
              [
                "Platform fees",
                formatMinor(
                  summary.data.platformFeesMinor,
                  summary.data.currency,
                ),
              ],
              [
                "Net to me",
                formatMinor(summary.data.netMinor, summary.data.currency),
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  {label}
                </p>
                <p className="mt-1 text-lg font-semibold text-slate-50">
                  {value}
                </p>
              </div>
            ))}
          </div>
        )}
        {latestOfferId ? (
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wide text-slate-500">
              Latest offer breakdown
            </p>
            <FareBreakdown offerId={latestOfferId} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function OperatorSOSQueue() {
  const active = useActiveSOS();
  const resolveSOS = useResolveSOS();
  const invalidation = useEconomicsSafetyInvalidation();

  return (
    <Card className="border-slate-800 bg-slate-950/60">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-slate-100">
          <Gavel className="h-5 w-5 text-rose-300" />
          Operator SOS queue
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {active.isLoading ? (
          <p className="text-sm text-slate-400">Loading active SOS alerts…</p>
        ) : active.isError ? (
          <p className="text-sm text-amber-200">
            Active SOS list unavailable —{" "}
            {active.error?.message ?? "try again"}.
          </p>
        ) : (active.data ?? []).length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-emerald-200">
            <ShieldCheck className="h-4 w-4" />
            No active SOS alerts.
          </p>
        ) : (
          (active.data ?? []).map((alert) => (
            <div
              key={alert.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-rose-400/40 bg-rose-500/5 p-3"
            >
              <div>
                <p className="font-mono text-xs text-slate-400">{alert.id}</p>
                <p className="text-sm font-medium text-rose-200">
                  Status: {alert.status}
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  resolveSOS.mutate(
                    { sosId: alert.id },
                    { onSuccess: () => invalidation.safety() },
                  )
                }
                disabled={resolveSOS.isPending}
                className="rounded-md border border-emerald-400/40 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-50"
              >
                Resolve
              </button>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export default function DriverSafetyCenter() {
  const sessionProfile = useSessionProfile();
  const isOperator = Boolean(
    sessionProfile.data?.role && operationsRoles.has(sessionProfile.data.role),
  );
  const [tripId, setTripId] = useState("");

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="space-y-2 border-b border-slate-800 pb-6">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-rose-300">
            Driver safety center
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-50">
            SOS, verified manifests, and transparent earnings
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-400">
            Trigger an SOS with a three-second hold, review who is riding
            before pickup against the verified passenger manifest, and see
            exactly what you net after platform fees.
          </p>
        </div>

        <section aria-label="SOS alert" className="space-y-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
            <Siren className="h-5 w-5 text-rose-300" />
            Emergency SOS
          </h2>
          <SOSButton tripId={tripId} />
        </section>

        <section aria-label="Trip manifest" className="space-y-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
            <UsersRound className="h-5 w-5 text-cyan-300" />
            Trip passenger manifest
          </h2>
          <Card className="border-slate-800 bg-slate-950/60">
            <CardContent className="space-y-4 p-5">
              <input
                value={tripId}
                onChange={(event) => setTripId(event.target.value)}
                placeholder="Trip ID"
                className="w-full max-w-md rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
              />
              <ManifestPanel tripId={tripId} />
            </CardContent>
          </Card>
        </section>

        <EarningsCard />

        {isOperator ? (
          <OperatorSOSQueue />
        ) : (
          <div className="flex gap-3 border border-slate-700 bg-slate-900/60 p-4 text-sm text-slate-300">
            <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
            <p className="leading-6 text-slate-400">
              The operator SOS queue is only visible to trust and operations
              roles. Server-side authorization is enforced independently of
              this view.
            </p>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
