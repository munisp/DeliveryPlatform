import { Car, Compass, Plane, Users } from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import { QueryErrorState } from "@/components/QueryState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

function money(amount: number) {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 2,
  }).format(amount);
}

export default function MobilityOverview() {
  const overview = trpc.mobility.overview.useQuery();
  const data = overview.data;

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="space-y-2 border-b border-slate-800 pb-6">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-cyan-300">
            Mobility operations
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-50">
            Live mobility overview
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-400">
            Real-time view across rider trips, driver supply, providers, and
            enterprise programs. Every figure below is computed from live
            tables; an empty deployment shows zeros, not demo data.
          </p>
        </div>

        {overview.isLoading ? (
          <p className="text-sm text-slate-400">Loading mobility overview…</p>
        ) : null}
        {overview.isError ? (
          <QueryErrorState
            resource="mobility overview"
            message={overview.error.message}
            onRetry={() => void overview.refetch()}
            retrying={overview.isRefetching}
          />
        ) : null}

        {data ? (
          <>
            <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
              {[
                ["Active trips", data.summary.active_trips],
                ["Active drivers", data.summary.active_drivers],
                ["Active providers", data.summary.active_providers],
                ["Airport-ready zones", data.summary.airport_ready_zones],
                ["Modes in use", data.summary.multimodal_modes],
                ["Business accounts", data.summary.business_accounts],
              ].map(([label, value]) => (
                <Card
                  key={label}
                  className="border-slate-800 bg-slate-950/60"
                >
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs text-slate-400">
                      {label}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-2xl font-semibold text-slate-50">
                    {value}
                  </CardContent>
                </Card>
              ))}
            </div>

            <div className="flex gap-3 border border-cyan-400/30 bg-cyan-400/5 p-4 text-sm text-cyan-50">
              <Compass className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300" />
              <p>{data.summary.recommended_action}</p>
            </div>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-100">
                  <Car className="h-5 w-5 text-cyan-300" />
                  Live trips
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.live_trips.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    No rider trips recorded yet. Trips appear here as soon as
                    riders book through the rider app.
                  </p>
                ) : (
                  data.live_trips.map((trip) => (
                    <div
                      key={trip.id}
                      className="flex flex-col justify-between gap-2 border-b border-slate-800 pb-3 last:border-0 md:flex-row md:items-center"
                    >
                      <div>
                        <p className="font-medium text-slate-100">
                          Trip #{trip.id} · {trip.trip_type}
                        </p>
                        <p className="text-xs text-slate-500">
                          {trip.modality} · {trip.status}
                          {trip.eta_minutes !== null
                            ? ` · ${trip.eta_minutes} min ${
                                trip.status === "completed"
                                  ? "trip time"
                                  : "elapsed"
                              }`
                            : ""}
                        </p>
                      </div>
                      <p className="text-sm font-semibold text-slate-100">
                        {money(trip.fare)}
                      </p>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-100">
                  <Users className="h-5 w-5 text-emerald-300" />
                  Mobility supply
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.mobility_supply.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    No drivers are onboarded yet. Supply appears here once
                    driver accounts are created.
                  </p>
                ) : (
                  data.mobility_supply.map((driver) => (
                    <div
                      key={driver.id}
                      className="flex flex-col justify-between gap-2 border-b border-slate-800 pb-3 last:border-0 md:flex-row md:items-center"
                    >
                      <div>
                        <p className="font-medium text-slate-100">
                          {driver.name}
                        </p>
                        <p className="text-xs text-slate-500">
                          {driver.status}
                          {driver.vehicle_class
                            ? ` · ${driver.vehicle_class}`
                            : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-4 text-sm text-slate-300">
                        <span>Accept {driver.acceptance_rate}%</span>
                        <span>Complete {driver.completion_rate}%</span>
                        {driver.airport_certified ? (
                          <span className="flex items-center gap-1 text-cyan-300">
                            <Plane className="h-4 w-4" />
                            Airport
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="text-base text-slate-100">
                  Service modes
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {data.service_modes.map((mode) => (
                  <span
                    key={mode}
                    className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300"
                  >
                    {mode}
                  </span>
                ))}
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>
    </DashboardLayout>
  );
}
