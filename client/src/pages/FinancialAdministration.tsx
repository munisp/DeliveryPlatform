import { useMutation, useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, DatabaseZap, FlaskConical, Landmark, RefreshCw, ShieldCheck } from "lucide-react";

type FinancialOverview = {
  immutableIdentityEnforced: boolean;
  retrievedAt: string;
  immutableTransfers: Array<{ transferId: string; payerFsp: string; payeeFsp: string; amountMinor: string; currency: string; state: string; updatedAt: string }>;
  inconsistentReconciliations: Array<{ id: string; transferId: string; transferState: string; platformRefundedMinor: string; platformNetSettledMinor: string; createdAt: string }>;
};
type Health = { dependencies: Array<{ name: string; status: "reachable" | "unhealthy" | "unreachable" | "unconfigured"; checkedAt: string; latencyMs: number | null }>; retrievedAt: string };
type Simulations = { enabled: boolean; productionBlocked: boolean; scenarios: string[] };

async function fetchAdmin<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error((await response.json().catch(() => ({ error: "request_failed" }))).error ?? "request_failed");
  return response.json() as Promise<T>;
}

function statusClass(status: Health["dependencies"][number]["status"]) {
  if (status === "reachable") return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
  if (status === "unconfigured") return "border-slate-600 bg-slate-800 text-slate-300";
  return "border-rose-400/30 bg-rose-400/10 text-rose-100";
}

export default function FinancialAdministration() {
  const overview = useQuery({ queryKey: ["finance-admin-overview"], queryFn: () => fetchAdmin<FinancialOverview>("/api/admin/finance/overview"), refetchInterval: 20_000 });
  const health = useQuery({ queryKey: ["finance-admin-health"], queryFn: () => fetchAdmin<Health>("/api/admin/finance/health"), refetchInterval: 15_000 });
  const simulations = useQuery({ queryKey: ["finance-admin-simulations"], queryFn: () => fetchAdmin<Simulations>("/api/admin/finance/simulations") });
  const simulation = useMutation({
    mutationFn: async (scenario: string) => {
      const response = await fetch(`/api/admin/finance/simulations/${scenario}`, { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error((await response.json().catch(() => ({ error: "simulation_unavailable" }))).error ?? "simulation_unavailable");
      return response.json() as Promise<{ scenario: string; status: string }>;
    },
  });

  const accessError = [overview.error, health.error, simulations.error].find(Boolean) as Error | undefined;
  if (accessError) {
    return <section className="mx-auto max-w-3xl rounded-2xl border border-rose-400/30 bg-rose-400/10 p-8 text-rose-100"><ShieldCheck className="mb-4 h-8 w-8" /><h1 className="text-2xl font-semibold">Financial administration is restricted</h1><p className="mt-3 leading-7">This workspace requires an authenticated platform financial administrator with verified MFA. {accessError.message.replace(/_/g, " ")}.</p></section>;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div><div className="flex items-center gap-2 text-cyan-200"><Landmark className="h-5 w-5" />Financial administration</div><h1 className="mt-2 text-3xl font-semibold text-white">Immutable funds oversight</h1><p className="mt-2 max-w-3xl leading-7 text-slate-300">Read-only visibility into durable transfer records, failed-refund reconciliation evidence, and dependency health. This page cannot alter funds.</p></div>
        <button type="button" onClick={() => { void overview.refetch(); void health.refetch(); }} className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-100 hover:border-cyan-400/50"><RefreshCw className="h-4 w-4" />Refresh</button>
      </header>

      <section className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-emerald-400/30 bg-emerald-400/10 p-5"><ShieldCheck className="h-5 w-5 text-emerald-200" /><div className="mt-3 text-sm text-emerald-100">Financial identity</div><div className="mt-1 text-xl font-semibold text-white">{overview.data?.immutableIdentityEnforced ? "Immutable" : "Unavailable"}</div></div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><DatabaseZap className="h-5 w-5 text-cyan-200" /><div className="mt-3 text-sm text-slate-300">Recent transfers</div><div className="mt-1 text-xl font-semibold text-white">{overview.data?.immutableTransfers.length ?? "—"}</div></div>
        <div className="rounded-2xl border border-amber-400/30 bg-amber-400/10 p-5"><AlertTriangle className="h-5 w-5 text-amber-200" /><div className="mt-3 text-sm text-amber-100">Inconsistent reconciliations</div><div className="mt-1 text-xl font-semibold text-white">{overview.data?.inconsistentReconciliations.length ?? "—"}</div></div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><div className="mb-4 flex items-center gap-2"><Activity className="h-5 w-5 text-cyan-200" /><h2 className="font-semibold text-white">Dependency health</h2><span className="text-xs text-slate-500">Refreshes every 15 seconds</span></div><div className="grid gap-3 md:grid-cols-2">{health.data?.dependencies.map((dependency) => <div key={dependency.name} className={`rounded-xl border p-4 ${statusClass(dependency.status)}`}><div className="flex items-center justify-between gap-2"><span className="font-medium">{dependency.name}</span><span className="text-xs uppercase tracking-wide">{dependency.status}</span></div><div className="mt-2 text-xs opacity-80">Checked {new Date(dependency.checkedAt).toLocaleTimeString()} · {dependency.latencyMs === null ? "no endpoint configured" : `${dependency.latencyMs} ms`}</div></div>)}</div></section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><div className="mb-4 flex items-center gap-2"><FlaskConical className="h-5 w-5 text-violet-200" /><div><h2 className="font-semibold text-white">Isolated recovery scenarios</h2><p className="mt-1 text-sm text-slate-400">These controls are disabled unless a separately configured non-production executor is present. They cannot run in production.</p></div></div><div className="flex flex-wrap gap-3">{simulations.data?.scenarios.map((scenario) => <button key={scenario} type="button" disabled={!simulations.data.enabled || simulation.isPending} onClick={() => simulation.mutate(scenario)} className="rounded-lg border border-violet-400/30 bg-violet-400/10 px-4 py-2 text-sm text-violet-100 disabled:cursor-not-allowed disabled:opacity-40">Run {scenario.replace(/-/g, " ")}</button>)}</div>{simulation.isError && <p role="alert" className="mt-4 text-sm text-rose-200">Simulation was not submitted: {(simulation.error as Error).message.replace(/_/g, " ")}.</p>}{simulation.data && <p role="status" className="mt-4 text-sm text-emerald-200">{simulation.data.scenario} scenario submitted to the isolated executor.</p>}</section>

      <section className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900"><div className="border-b border-slate-800 px-5 py-4"><h2 className="font-semibold text-white">Immutable transfer records</h2><p className="mt-1 text-sm text-slate-400">Most recent 100 records. Monetary amounts are stored in minor units.</p></div><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-slate-950/60 text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3">Transfer</th><th className="px-5 py-3">Parties</th><th className="px-5 py-3">Minor units</th><th className="px-5 py-3">State</th><th className="px-5 py-3">Updated</th></tr></thead><tbody>{overview.data?.immutableTransfers.map((transfer) => <tr key={transfer.transferId} className="border-t border-slate-800 text-slate-200"><td className="px-5 py-3 font-mono text-xs">{transfer.transferId}</td><td className="px-5 py-3">{transfer.payerFsp} → {transfer.payeeFsp}</td><td className="px-5 py-3">{transfer.amountMinor} {transfer.currency}</td><td className="px-5 py-3">{transfer.state}</td><td className="px-5 py-3 text-slate-400">{new Date(transfer.updatedAt).toLocaleString()}</td></tr>)}</tbody></table></section>

      <section className="rounded-2xl border border-rose-400/30 bg-rose-400/5 p-5"><h2 className="font-semibold text-rose-100">Failed-refund reconciliation events</h2><p className="mt-1 text-sm text-rose-200/80">Any record below requires investigation before settlement or customer communication.</p><div className="mt-4 space-y-2">{overview.data?.inconsistentReconciliations.length ? overview.data.inconsistentReconciliations.map((event) => <div key={event.id} className="rounded-lg border border-rose-400/20 bg-slate-950/40 p-3 text-sm text-slate-200"><span className="font-mono text-xs">{event.transferId}</span> · {event.transferState} · refunded {event.platformRefundedMinor} · net {event.platformNetSettledMinor} · {new Date(event.createdAt).toLocaleString()}</div>) : <p className="text-sm text-slate-400">No inconsistent reconciliation events are currently recorded.</p>}</div></section>
    </div>
  );
}
