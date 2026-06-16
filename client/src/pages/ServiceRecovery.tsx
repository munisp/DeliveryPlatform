import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

export default function ServiceRecovery() {
  const query = trpc.serviceRecovery.workspace.useQuery();
  const data = query.data;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="space-y-3">
          <Badge variant="secondary">Service recovery</Badge>
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">Service Recovery Console</h1>
            <p className="mt-2 max-w-3xl text-slate-400">
              Manage incident triage, compensation routing, customer save actions, and operational follow-through from a connected recovery workspace.
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader>
              <CardDescription>Open Incidents</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.open_incidents ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Compensation Pending</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.compensation_pending ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Save Rate</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.save_rate ?? 0}%</CardTitle>
            </CardHeader>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.2fr_1.8fr]">
          <Card>
            <CardHeader>
              <CardTitle>Recommended Action</CardTitle>
              <CardDescription>Prioritized recovery direction emitted by the rebuilt recovery workspace.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-7 text-slate-300">{data?.summary.recommended_action ?? "Loading recovery guidance…"}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Incident Queues</CardTitle>
              <CardDescription>The current recovery lanes that operators can work through in sequence.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3 text-sm leading-6 text-slate-300">
                {(data?.queues ?? []).map((item) => (
                  <li key={item} className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">{item}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
}
