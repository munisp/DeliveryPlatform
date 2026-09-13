import { HeartPulse, ShieldCheck, Stethoscope } from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import { QueryErrorState } from "@/components/QueryState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

export default function HealthcareTransport() {
  const healthcare = trpc.mobility.healthcare.useQuery();
  const data = healthcare.data;

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="space-y-2 border-b border-slate-800 pb-6">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-cyan-300">
            Care transportation
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-50">
            Healthcare transport
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-400">
            Scheduled care trips, transport programs, and compliance posture
            from live booking records.
          </p>
        </div>

        {healthcare.isLoading ? (
          <p className="text-sm text-slate-400">
            Loading healthcare transport…
          </p>
        ) : null}
        {healthcare.isError ? (
          <QueryErrorState
            resource="healthcare transport data"
            message={healthcare.error.message}
            onRetry={() => void healthcare.refetch()}
            retrying={healthcare.isRefetching}
          />
        ) : null}

        {data ? (
          <>
            <div className="grid gap-4 md:grid-cols-4">
              {[
                ["Care programs", data.summary.care_programs],
                ["Scheduled trips", data.summary.scheduled_trips],
                ["Compliant providers", data.summary.compliant_providers],
                ["Compliance packs", data.summary.compliance_packs],
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
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300" />
              <p>{data.summary.recommended_action}</p>
            </div>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-100">
                  <HeartPulse className="h-5 w-5 text-rose-300" />
                  Active cases
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.active_cases.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    No scheduled or in-progress care trips. Bookings appear
                    here once a care coordinator schedules transport.
                  </p>
                ) : (
                  data.active_cases.map((booking) => (
                    <div
                      key={booking.id}
                      className="flex flex-col justify-between gap-2 border-b border-slate-800 pb-3 last:border-0 md:flex-row md:items-center"
                    >
                      <div>
                        <p className="font-medium text-slate-100">
                          Case #{booking.id} ·{" "}
                          {booking.service_line === "patient_trip"
                            ? "Patient trip"
                            : "Regulated delivery"}
                        </p>
                        <p className="text-xs text-slate-500">
                          {booking.status}
                        </p>
                      </div>
                      <p className="text-sm text-slate-300">
                        {booking.eta_minutes === null
                          ? "No appointment time set"
                          : `Appointment in ${booking.eta_minutes} min`}
                      </p>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-100">
                  <Stethoscope className="h-5 w-5 text-emerald-300" />
                  Transport programs
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.transport_programs.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    No care programs have bookings yet. Programs are derived
                    from real bookings once transport is scheduled.
                  </p>
                ) : (
                  data.transport_programs.map((program) => (
                    <div
                      key={program.id}
                      className="flex flex-col justify-between gap-2 border-b border-slate-800 pb-3 last:border-0 md:flex-row md:items-center"
                    >
                      <div>
                        <p className="font-medium text-slate-100">
                          {program.name}
                        </p>
                        <p className="text-xs text-slate-500">
                          {program.compliance ?? "No compliance notes recorded"}
                        </p>
                      </div>
                      <span className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300">
                        {program.schedule_mode}
                      </span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="text-base text-slate-100">
                  Compliance packs
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {data.compliance_packs.map((pack) => (
                  <span
                    key={pack}
                    className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300"
                  >
                    {pack}
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
