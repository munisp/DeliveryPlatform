import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

const currency = (value: number) =>
  `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const dateLabel = (value: string | Date | null | undefined) =>
  value ? new Date(value).toLocaleString() : "—";

export default function TrustConsole() {
  const query = trpc.consoles.trustConsole.useQuery();
  const data = query.data;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="space-y-3">
          <Badge variant="secondary">Operations console</Badge>
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">Trust Console</h1>
            <p className="mt-2 max-w-3xl text-slate-400">
              High-risk support cases, finance exceptions, audit activity, and recent policy changes for trust and safety operations.
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader>
              <CardDescription>High-Risk Cases</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.high_risk_cases ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Finance Exceptions</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.finance_exceptions ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Approval Backlog</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.approval_backlog ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Recent Policy Changes</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.recent_policy_changes ?? 0}</CardTitle>
            </CardHeader>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Risk Cases</CardTitle>
              <CardDescription>Urgent and critical tickets, refunds, claims, and payment disputes needing operator review.</CardDescription>
            </CardHeader>
            <CardContent>
              {query.isLoading ? (
                <p className="text-sm text-slate-400">Loading risk cases…</p>
              ) : (data?.risk_cases ?? []).length === 0 ? (
                <p className="text-sm text-slate-400">
                  No high-risk cases are open. Urgent tickets, refund claims, and payment disputes will appear here when raised.
                </p>
              ) : (
                <ul className="space-y-3 text-sm text-slate-300">
                  {(data?.risk_cases ?? []).map((riskCase) => (
                    <li key={riskCase.id} className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-white">{riskCase.subject}</span>
                        <div className="flex items-center gap-2">
                          <Badge variant={riskCase.priority === "critical" ? "destructive" : "secondary"}>{riskCase.priority}</Badge>
                          <Badge variant="outline">{riskCase.status}</Badge>
                        </div>
                      </div>
                      <p className="mt-2 text-slate-400">
                        {riskCase.type} · opened {dateLabel(riskCase.created_at)}
                      </p>
                      <p className="mt-2 leading-6 text-slate-400">{riskCase.next_action}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Finance Exceptions</CardTitle>
              <CardDescription>Failed or pending transactions plus refunds and payouts requiring reconciliation.</CardDescription>
            </CardHeader>
            <CardContent>
              {query.isLoading ? (
                <p className="text-sm text-slate-400">Loading finance exceptions…</p>
              ) : (data?.finance_exceptions ?? []).length === 0 ? (
                <p className="text-sm text-slate-400">
                  No finance exceptions are pending. Failed transactions, refunds, and payouts will be listed here for reconciliation.
                </p>
              ) : (
                <ul className="space-y-3 text-sm text-slate-300">
                  {(data?.finance_exceptions ?? []).map((exception) => (
                    <li key={exception.id} className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                      <div>
                        <p className="font-semibold text-white">
                          {exception.type} · {currency(exception.amount)}
                        </p>
                        <p className="text-slate-400">
                          {exception.entity_type} #{exception.entity_id} · {dateLabel(exception.created_at)}
                        </p>
                      </div>
                      <Badge variant={exception.status === "failed" ? "destructive" : "secondary"}>{exception.status}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Recent Audit Events</CardTitle>
              <CardDescription>Latest recorded administrative and operational actions.</CardDescription>
            </CardHeader>
            <CardContent>
              {query.isLoading ? (
                <p className="text-sm text-slate-400">Loading audit events…</p>
              ) : (data?.recent_audit_events ?? []).length === 0 ? (
                <p className="text-sm text-slate-400">
                  No audit events recorded yet. Administrative actions will be tracked here as they occur.
                </p>
              ) : (
                <ul className="space-y-3 text-sm text-slate-300">
                  {(data?.recent_audit_events ?? []).map((event: any, index: number) => (
                    <li key={event.id ?? index} className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                      <p className="font-semibold text-white">{event.action ?? "Recorded action"}</p>
                      <p className="mt-1 text-slate-400">
                        {event.entity ?? "entity"} {event.entity_id != null ? `#${event.entity_id}` : ""} · {dateLabel(event.created_at)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Policy Updates</CardTitle>
              <CardDescription>Recently changed system configuration entries affecting policy behavior.</CardDescription>
            </CardHeader>
            <CardContent>
              {query.isLoading ? (
                <p className="text-sm text-slate-400">Loading policy updates…</p>
              ) : (data?.policy_updates ?? []).length === 0 ? (
                <p className="text-sm text-slate-400">
                  No policy configuration changes recorded. System configuration updates will appear here when modified.
                </p>
              ) : (
                <ul className="space-y-3 text-sm text-slate-300">
                  {(data?.policy_updates ?? []).map((update: any, index: number) => (
                    <li key={update.key ?? index} className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                      <div>
                        <p className="font-semibold text-white">{update.key}</p>
                        <p className="text-slate-400">updated {dateLabel(update.updated_at)}</p>
                      </div>
                      <Badge variant="secondary">{update.category ?? "general"}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
}
