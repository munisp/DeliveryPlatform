import { Briefcase, Receipt, ScrollText, Users } from "lucide-react";

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

export default function BusinessTravel() {
  const travel = trpc.mobility.businessTravel.useQuery();
  const data = travel.data;

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="space-y-2 border-b border-slate-800 pb-6">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-cyan-300">
            Enterprise travel
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-50">
            Business travel programs
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-400">
            Enterprise accounts, traveler spend, and open expense items from
            the live business travel ledger.
          </p>
        </div>

        {travel.isLoading ? (
          <p className="text-sm text-slate-400">Loading business travel…</p>
        ) : null}
        {travel.isError ? (
          <QueryErrorState
            resource="business travel data"
            message={travel.error.message}
            onRetry={() => void travel.refetch()}
            retrying={travel.isRefetching}
          />
        ) : null}

        {data ? (
          <>
            <div className="grid gap-4 md:grid-cols-4">
              {[
                ["Enterprise accounts", data.summary.enterprise_accounts],
                ["Active travelers", data.summary.active_travelers],
                ["Open expense items", data.summary.open_expense_items],
                ["Policy templates", data.summary.policy_templates],
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
                  <Briefcase className="h-5 w-5 text-cyan-300" />
                  Travel programs
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.travel_programs.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    No enterprise travel accounts exist yet. Programs appear
                    here once a business travel account is created.
                  </p>
                ) : (
                  data.travel_programs.map((program) => (
                    <div
                      key={program.id}
                      className="flex flex-col justify-between gap-2 border-b border-slate-800 pb-3 last:border-0 md:flex-row md:items-center"
                    >
                      <div>
                        <p className="font-medium text-slate-100">
                          {program.name}
                        </p>
                        <p className="text-xs text-slate-500">
                          {program.service_mix}
                        </p>
                      </div>
                      <span className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300">
                        {program.approval_mode}
                      </span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-100">
                  <Users className="h-5 w-5 text-emerald-300" />
                  Travelers
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.travelers.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    No travelers have booked business trips yet. Spend and
                    compliance appear here once trips are recorded.
                  </p>
                ) : (
                  data.travelers.map((traveler) => (
                    <div
                      key={traveler.id}
                      className="flex flex-col justify-between gap-2 border-b border-slate-800 pb-3 last:border-0 md:flex-row md:items-center"
                    >
                      <div>
                        <p className="font-medium text-slate-100">
                          {traveler.name ?? traveler.email ?? `User ${traveler.id}`}
                        </p>
                        <p className="text-xs text-slate-500">
                          {traveler.role}
                          {traveler.email ? ` · ${traveler.email}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-4 text-sm">
                        <span className="text-slate-100">
                          {money(traveler.spend_ytd)} YTD
                        </span>
                        <span
                          className={
                            traveler.compliance_state === "review"
                              ? "text-amber-200"
                              : "text-emerald-200"
                          }
                        >
                          {traveler.compliance_state === "review"
                            ? "Review"
                            : "In policy"}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-100">
                  <ScrollText className="h-5 w-5 text-amber-300" />
                  Policy templates
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-2 md:grid-cols-2">
                {data.policy_templates.map((template) => (
                  <div
                    key={template}
                    className="flex items-center gap-2 rounded-md border border-slate-800 p-3 text-sm text-slate-300"
                  >
                    <Receipt className="h-4 w-4 shrink-0 text-slate-500" />
                    {template}
                  </div>
                ))}
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>
    </DashboardLayout>
  );
}
