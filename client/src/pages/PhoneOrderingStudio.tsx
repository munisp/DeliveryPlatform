import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

export default function PhoneOrderingStudio() {
  const query = trpc.phoneOrdering.workspace.useQuery();
  const data = query.data;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="space-y-3">
          <Badge variant="outline">Phone ordering</Badge>
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">Phone Ordering Studio</h1>
            <p className="mt-2 max-w-3xl text-slate-400">
              Coordinate assisted menu capture, substitution handling, stored-customer lookup, and kitchen handoff from a dedicated call-center workflow instead of a generic scaffold.
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader>
              <CardDescription>Staffed Lines</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.staffed_lines ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Active Calls</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.active_calls ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Substitution Cases</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.substitution_cases ?? 0}</CardTitle>
            </CardHeader>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.2fr_1.8fr]">
          <Card>
            <CardHeader>
              <CardTitle>Recommended Action</CardTitle>
              <CardDescription>Immediate operator guidance emitted by the connected phone-ordering workspace.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-7 text-slate-300">{data?.summary.recommended_action ?? "Loading phone-ordering guidance…"}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Call Flows</CardTitle>
              <CardDescription>The assisted-ordering flows currently modeled in the platform.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3 text-sm leading-6 text-slate-300">
                {(data?.call_flows ?? []).map((item) => (
                  <li key={item} className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">{item}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <Card>
            <CardHeader>
              <CardTitle>{data?.longcat?.assistant_name ?? "LongCat Concierge"}</CardTitle>
              <CardDescription>
                AI-guided phone-order orchestration modeled after the conversational ordering and accessibility use case.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-slate-300">
              <p className="leading-7">{data?.longcat?.conversation_goal ?? "Loading conversational ordering strategy…"}</p>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-cyan-200">Operator Script</p>
                <p className="mt-2 leading-7">{data?.longcat?.operator_script ?? "Awaiting assistant script…"}</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-cyan-200">Accessibility Note</p>
                <p className="mt-2 leading-7">{data?.longcat?.accessibility_note ?? "Awaiting accessibility guidance…"}</p>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Personalized Recommendations</CardTitle>
                <CardDescription>How the assistant should steer callers toward faster and better-fit orders.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3 text-sm leading-6 text-slate-300">
                  {(data?.longcat?.personalized_recommendations ?? []).map((item) => (
                    <li key={item} className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">{item}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Next Actions</CardTitle>
                <CardDescription>Immediate operational steps synthesized by the local AI copilot.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3 text-sm leading-6 text-slate-300">
                  {(data?.longcat?.next_actions ?? []).map((item) => (
                    <li key={item} className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">{item}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
