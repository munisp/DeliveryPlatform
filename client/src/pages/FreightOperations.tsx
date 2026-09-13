import { CircleAlert, Container, Truck } from "lucide-react";

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

export default function FreightOperations() {
  const freight = trpc.mobility.freight.useQuery();
  const data = freight.data;

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="space-y-2 border-b border-slate-800 pb-6">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-cyan-300">
            Freight control tower
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-50">
            Freight operations
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-400">
            Load board, lanes, and carrier network from the live freight
            ledger. No synthetic loads are shown.
          </p>
        </div>

        {freight.isLoading ? (
          <p className="text-sm text-slate-400">Loading freight operations…</p>
        ) : null}
        {freight.isError ? (
          <QueryErrorState
            resource="freight operations data"
            message={freight.error.message}
            onRetry={() => void freight.refetch()}
            retrying={freight.isRefetching}
          />
        ) : null}

        {data ? (
          <>
            <div className="grid gap-4 md:grid-cols-4">
              {[
                ["Shipper accounts", data.summary.shipper_accounts],
                ["Carrier lanes", data.summary.carrier_lanes],
                ["Active loads", data.summary.active_loads],
                ["Open procurement", data.summary.procurement_events],
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
              {data.summary.recommended_action}
            </p>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-100">
                  <Container className="h-5 w-5 text-cyan-300" />
                  Load board
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.load_board.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    No freight loads have been tendered yet. Loads appear here
                    as shippers post them.
                  </p>
                ) : (
                  data.load_board.map((load) => (
                    <div
                      key={load.id}
                      className="flex flex-col justify-between gap-2 border-b border-slate-800 pb-3 last:border-0 md:flex-row md:items-center"
                    >
                      <div>
                        <p className="font-medium text-slate-100">
                          {load.lane}
                        </p>
                        <p className="text-xs text-slate-500">
                          {load.equipment} · {load.status}
                          {load.address ? ` · ${load.address}` : ""}
                        </p>
                      </div>
                      <p className="text-sm font-semibold text-slate-100">
                        {money(load.value)}
                      </p>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-100">
                  <Truck className="h-5 w-5 text-emerald-300" />
                  Carrier network
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-3 border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-amber-100">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                  <p>
                    Carrier compliance scoring is not instrumented yet, so no
                    score is shown. Verification status comes directly from
                    provider onboarding records.
                  </p>
                </div>
                {data.carrier_network.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    No carriers or freight shippers are onboarded yet. Providers
                    with freight or logistics categories appear here.
                  </p>
                ) : (
                  data.carrier_network.map((carrier) => (
                    <div
                      key={carrier.id}
                      className="flex flex-col justify-between gap-2 border-b border-slate-800 pb-3 last:border-0 md:flex-row md:items-center"
                    >
                      <div>
                        <p className="font-medium text-slate-100">
                          {carrier.name}
                        </p>
                        <p className="text-xs text-slate-500">
                          {carrier.category ?? "general"} · {carrier.status}
                        </p>
                      </div>
                      <span
                        className={
                          carrier.verification_status === "verified"
                            ? "text-sm text-emerald-200"
                            : "text-sm text-amber-200"
                        }
                      >
                        {carrier.verification_status}
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
