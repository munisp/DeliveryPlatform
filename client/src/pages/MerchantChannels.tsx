import { Link } from "wouter";

import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

type LogisticsTowerSummary = {
  summary?: string;
  network?: {
    resilience_band?: string;
    critical_nodes?: number;
    constrained_nodes?: number;
  };
};

export default function MerchantChannels() {
  const query = trpc.merchantChannels.workspace.useQuery();
  const logisticsQuery = trpc.localCommerceSuperGateway.logisticsControlTower.useQuery({ city: "Lagos" });
  const logisticsTower = logisticsQuery.data as LogisticsTowerSummary | undefined;
  const data = query.data;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="space-y-3">
          <Badge>Merchant channels</Badge>
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">Merchant Channel Workspace</h1>
            <p className="mt-2 max-w-3xl text-slate-400">
              Coordinate owned storefronts, branded ordering apps, tableside ordering, phone capture, and partner marketplace syndication from one operator surface.
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader>
              <CardDescription>Activated Channels</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.activated_channels ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Branded Storefronts</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.branded_storefronts ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Partner Channels</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.partner_channels ?? 0}</CardTitle>
            </CardHeader>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.2fr_1.8fr]">
          <Card>
            <CardHeader>
              <CardTitle>Supply Chain Control Tower</CardTitle>
              <CardDescription>Instant-retail resilience, warehouse pressure, and middleware readiness linked to merchant growth.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-slate-300">
              <p>{logisticsTower?.summary ?? "Loading logistics control-tower summary…"}</p>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-cyan-200">Current risk band</p>
                <p className="mt-2 leading-7">
                  {logisticsTower?.network?.resilience_band ?? "unknown"} · {logisticsTower?.network?.critical_nodes ?? 0} critical nodes · {logisticsTower?.network?.constrained_nodes ?? 0} constrained nodes
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <Link href="/merchant-commerce" className="inline-flex rounded-full bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-400">
                  Open merchant store portal
                </Link>
                <Link href="/logistics-control-tower" className="inline-flex rounded-full border border-cyan-400/30 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/20">
                  Open logistics control tower
                </Link>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Recommended Action</CardTitle>
              <CardDescription>Operator guidance derived from the connected merchant-channel workspace.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-7 text-slate-300">{data?.summary.recommended_action ?? "Loading channel priorities…"}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Channel Mix</CardTitle>
              <CardDescription>The active go-to-market surfaces currently governed in the platform.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3 text-sm leading-6 text-slate-300">
                {(data?.channel_mix ?? []).map((item) => (
                  <li key={item} className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">{item}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <Card>
            <CardHeader>
              <CardTitle>{data?.longcat?.consultant_name ?? "LongCat Merchant Copilot"}</CardTitle>
              <CardDescription>
                AI-guided merchant decision support modeled after the Meituan-style market, menu, and financial consulting use case.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-slate-300">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-cyan-200">Market Brief</p>
                <p className="mt-2 leading-7">{data?.longcat?.market_brief ?? "Loading merchant market analysis…"}</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-cyan-200">Demand Forecast</p>
                <p className="mt-2 leading-7">{data?.longcat?.demand_forecast ?? "Awaiting demand forecast…"}</p>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Menu Actions</CardTitle>
                <CardDescription>How the AI copilot would refine offer mix and featured dishes.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3 text-sm leading-6 text-slate-300">
                  {(data?.longcat?.menu_actions ?? []).map((item) => (
                    <li key={item} className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">{item}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Channel Actions</CardTitle>
                <CardDescription>Recommended channel and campaign moves for the next operating cycle.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3 text-sm leading-6 text-slate-300">
                  {(data?.longcat?.channel_actions ?? []).map((item) => (
                    <li key={item} className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">{item}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Financial Watchouts</CardTitle>
                <CardDescription>Risk controls the merchant operator should review before scaling demand.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3 text-sm leading-6 text-slate-300">
                  {(data?.longcat?.financial_watchouts ?? []).map((item) => (
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
