import { Clock, MapPin, Ticket, UserRound } from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

function money(amount: number) {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 2,
  }).format(amount);
}

export default function RiderApp() {
  const rider = trpc.mobility.riderApp.useQuery();
  const data = rider.data;

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="space-y-2 border-b border-slate-800 pb-6">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-cyan-300">
            Rider experience
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-50">
            Rider app activity
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-400">
            Booking modes, recent rider activity, and destination suggestions
            computed from live trip, order, and provider data.
          </p>
        </div>

        {rider.isLoading ? (
          <p className="text-sm text-slate-400">Loading rider activity…</p>
        ) : null}
        {rider.error ? (
          <p className="border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-100">
            {rider.error.message}
          </p>
        ) : null}

        {data ? (
          <>
            <div className="grid gap-4 md:grid-cols-4">
              {[
                ["Saved places", data.summary.saved_places],
                ["Active promotions", data.summary.active_promotions],
                ["Membership benefits", data.summary.membership_benefits],
                ["Open support threads", data.summary.support_threads],
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

            <p className="text-sm text-slate-400">
              {data.summary.recommended_next_step}
            </p>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-100">
                  <Clock className="h-5 w-5 text-cyan-300" />
                  Booking modes
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-3">
                {data.booking_modes.map((mode) => (
                  <div
                    key={mode.key}
                    className="rounded-md border border-slate-800 p-4"
                  >
                    <p className="font-medium text-slate-100">{mode.label}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {mode.eta_minutes === null
                        ? "No live timing data yet — ETA appears once trips complete matching."
                        : `Typical pickup in ~${mode.eta_minutes} min`}
                    </p>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-100">
                  <UserRound className="h-5 w-5 text-emerald-300" />
                  Recent activity
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.recent_activity.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    No rider activity yet. Trips and delivery orders appear here
                    as they are placed.
                  </p>
                ) : (
                  data.recent_activity.map((item) => (
                    <div
                      key={`${item.experience_type}-${item.id}`}
                      className="flex flex-col justify-between gap-2 border-b border-slate-800 pb-3 last:border-0 md:flex-row md:items-center"
                    >
                      <div>
                        <p className="font-medium text-slate-100">
                          {item.experience_type === "delivery"
                            ? "Delivery order"
                            : "Trip"}{" "}
                          #{item.id}
                        </p>
                        <p className="text-xs text-slate-500">
                          {item.status}
                          {item.address ? ` · ${item.address}` : ""}
                        </p>
                      </div>
                      <p className="text-sm font-semibold text-slate-100">
                        {money(item.amount)}
                      </p>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-100">
                  <MapPin className="h-5 w-5 text-amber-300" />
                  Suggested destinations
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.suggested_destinations.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    No providers are available to suggest yet. Suggestions
                    appear once service providers are onboarded and rated.
                  </p>
                ) : (
                  data.suggested_destinations.map((destination) => (
                    <div
                      key={destination.id}
                      className="flex items-center justify-between border-b border-slate-800 pb-3 last:border-0"
                    >
                      <div>
                        <p className="font-medium text-slate-100">
                          {destination.label}
                        </p>
                        <p className="text-xs text-slate-500">
                          {destination.category ?? "general"}
                        </p>
                      </div>
                      <span className="flex items-center gap-1 text-sm text-amber-200">
                        <Ticket className="h-4 w-4" />
                        {destination.rating.toFixed(1)}
                      </span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>
    </DashboardLayout>
  );
}
