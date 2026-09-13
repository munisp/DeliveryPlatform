import DashboardLayout from "@/components/DashboardLayout";
import { QueryErrorState } from "@/components/QueryState";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

const dateLabel = (value: string | Date | null | undefined) =>
  value ? new Date(value).toLocaleString() : "—";

export default function ExperimentConsole() {
  const query = trpc.consoles.experimentConsole.useQuery();
  const data = query.data;

  if (query.isError) {
    return (
      <DashboardLayout>
        <div className="space-y-6">
          <QueryErrorState
            resource="experiment console data"
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
            <h1 className="text-3xl font-semibold tracking-tight text-white">Experiment Console</h1>
            <p className="mt-2 max-w-3xl text-slate-400">
              Controlled rollouts and growth levers across campaigns, loyalty, and experiment surfaces with guardrails and ownership.
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader>
              <CardDescription>Active Campaigns</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.active_campaigns ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Queued Campaigns</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.queued_campaigns ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Loyalty Events</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.loyalty_events ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Active Rollouts</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.active_rollouts ?? 0}</CardTitle>
            </CardHeader>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Recommended Next Step</CardTitle>
            <CardDescription>Experiment program guidance from the console summary.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-7 text-slate-300">
              {data?.summary.recommended_next_step ?? "Loading experiment guidance…"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Suggested Experiments</CardTitle>
            <CardDescription>Rollout entries with target surface, primary metric, guardrails, and ownership.</CardDescription>
          </CardHeader>
          <CardContent>
            {query.isLoading ? (
              <p className="text-sm text-slate-400">Loading experiments…</p>
            ) : (data?.suggested_experiments ?? []).length === 0 ? (
              <p className="text-sm text-slate-400">
                No experiment rollouts are configured yet. Define rollout entries with guardrails to start controlled experiments on pricing, dispatch, and retention.
              </p>
            ) : (
              <ul className="space-y-3 text-sm text-slate-300">
                {(data?.suggested_experiments ?? []).map((experiment) => (
                  <li key={experiment.id} className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-white">{experiment.name}</span>
                      <div className="flex items-center gap-2">
                        <Badge variant={experiment.status === "active" ? "default" : "secondary"}>{experiment.status}</Badge>
                      </div>
                    </div>
                    <div className="mt-2 grid gap-1 text-slate-400 md:grid-cols-2">
                      <span>Surface: {experiment.target_surface ?? "—"}</span>
                      <span>Primary metric: {experiment.primary_metric ?? "—"}</span>
                      <span>Rollout: {experiment.rollout}</span>
                      <span>Owner: {experiment.owner ?? "Unassigned"}</span>
                    </div>
                    {(experiment.guardrails ?? []).length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {experiment.guardrails.map((guardrail) => (
                          <Badge key={guardrail} variant="outline">{guardrail}</Badge>
                        ))}
                      </div>
                    ) : null}
                    <p className="mt-2 text-slate-500">Updated {dateLabel(experiment.updated_at)}</p>
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
