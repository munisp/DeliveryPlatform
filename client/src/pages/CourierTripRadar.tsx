import DashboardLayout from "@/components/DashboardLayout";
import { QueryErrorState } from "@/components/QueryState";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

const currency = (value: number) =>
  `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const dateLabel = (value: string | Date | null | undefined) =>
  value ? new Date(value).toLocaleString() : "—";

export default function CourierTripRadar() {
  const query = trpc.consoles.courierTripRadar.useQuery();
  const data = query.data;

  if (query.isError) {
    return (
      <DashboardLayout>
        <div className="space-y-6">
          <QueryErrorState
            resource="courier trip radar data"
            message={query.error.message}
            onRetry={() => void query.refetch()}
            retrying={query.isRefetching}
          />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="space-y-3">
          <Badge variant="secondary">Operations console</Badge>
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">Courier Trip Radar</h1>
            <p className="mt-2 max-w-3xl text-slate-400">
              Live courier availability, trip radar for long-haul and multi-stop jobs, and incentive boosts in flight.
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader>
              <CardDescription>Online Couriers</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.online_couriers ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Radar Trips</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.radar_trips ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Long-Trip Candidates</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.long_trip_candidates ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Pending Incentives</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.pending_incentives ?? 0}</CardTitle>
            </CardHeader>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Radar Recommendation</CardTitle>
            <CardDescription>Dispatch guidance derived from current courier and trip mix.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-7 text-slate-300">
              {data?.summary.recommendation ?? "Loading trip radar guidance…"}
            </p>
          </CardContent>
        </Card>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Courier Roster</CardTitle>
              <CardDescription>Top couriers by completed deliveries with availability and acceptance posture.</CardDescription>
            </CardHeader>
            <CardContent>
              {query.isLoading ? (
                <p className="text-sm text-slate-400">Loading couriers…</p>
              ) : (data?.drivers ?? []).length === 0 ? (
                <p className="text-sm text-slate-400">
                  No couriers are registered yet. Once drivers join and complete deliveries, their availability and earnings posture will appear here.
                </p>
              ) : (
                <ul className="space-y-3 text-sm text-slate-300">
                  {(data?.drivers ?? []).map((driver) => (
                    <li key={driver.id} className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-white">{driver.name}</span>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">{driver.availability}</Badge>
                          <Badge variant="secondary">{driver.status}</Badge>
                        </div>
                      </div>
                      <div className="mt-2 grid gap-1 text-slate-400 md:grid-cols-2">
                        <span>Rating: {driver.rating}</span>
                        <span>Completed: {driver.completed_deliveries}</span>
                        <span>Active orders: {driver.active_orders}</span>
                        <span>Acceptance rate: {driver.acceptance_rate}%</span>
                      </div>
                      <p className="mt-2 text-slate-500">Total earnings: {currency(driver.total_earnings)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Trip Radar</CardTitle>
              <CardDescription>Recently updated orders flagged for long-haul and multi-stop potential.</CardDescription>
            </CardHeader>
            <CardContent>
              {query.isLoading ? (
                <p className="text-sm text-slate-400">Loading trip radar…</p>
              ) : (data?.trip_radar ?? []).length === 0 ? (
                <p className="text-sm text-slate-400">
                  No trips are on the radar yet. Long-haul and multi-stop candidates will surface here as orders flow in.
                </p>
              ) : (
                <ul className="space-y-3 text-sm text-slate-300">
                  {(data?.trip_radar ?? []).map((trip) => (
                    <li key={trip.id} className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-white">Trip #{trip.id}</span>
                        <div className="flex items-center gap-2">
                          {trip.long_trip ? <Badge>Long trip</Badge> : null}
                          {trip.multi_stop ? <Badge variant="outline">Multi-stop</Badge> : null}
                          <Badge variant="secondary">{trip.status}</Badge>
                        </div>
                      </div>
                      <p className="mt-2 text-slate-400">
                        {trip.pickup_address ?? "Pickup on file"} → {trip.delivery_address ?? "Dropoff on file"}
                      </p>
                      <p className="mt-1 text-slate-500">
                        {currency(trip.total_amount)} · ETA {trip.eta_minutes} min · incentive boost ×{trip.incentive_boost}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Incentives in Flight</CardTitle>
            <CardDescription>Recent courier incentives and their approval status.</CardDescription>
          </CardHeader>
          <CardContent>
            {query.isLoading ? (
              <p className="text-sm text-slate-400">Loading incentives…</p>
            ) : (data?.incentives ?? []).length === 0 ? (
              <p className="text-sm text-slate-400">
                No courier incentives have been issued yet. Incentive boosts tied to radar trips will appear here.
              </p>
            ) : (
              <ul className="space-y-3 text-sm text-slate-300">
                {(data?.incentives ?? []).map((incentive) => (
                  <li key={incentive.id} className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                    <div>
                      <p className="font-semibold text-white">{incentive.incentive_type}</p>
                      <p className="text-slate-400">{currency(incentive.amount)} · {dateLabel(incentive.created_at)}</p>
                    </div>
                    <Badge variant="secondary">{incentive.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
