import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

const currency = (value: number) =>
  `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function MerchantHub() {
  const query = trpc.consoles.merchantHub.useQuery();
  const data = query.data;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="space-y-3">
          <Badge variant="secondary">Operations console</Badge>
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">Merchant Hub</h1>
            <p className="mt-2 max-w-3xl text-slate-400">
              Live view of provider health, settlement exposure, marketing campaigns, and dispute pressure across the merchant network.
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader>
              <CardDescription>Total Providers</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.total_providers ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Active Providers</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.active_providers ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Verified Providers</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.verified_providers ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Average Rating</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.average_rating ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Average Commission</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.average_commission ?? 0}%</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Dispute-Like Tickets</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.dispute_like_tickets ?? 0}</CardTitle>
            </CardHeader>
          </Card>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Settlement Exposure</CardTitle>
              <CardDescription>Driver settlement totals by status that affect merchant payout operations.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3 text-sm text-slate-300">
                <li className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                  <span>Pending settlements</span>
                  <span className="font-semibold text-white">{currency(data?.summary.pending_settlements ?? 0)}</span>
                </li>
                <li className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                  <span>Approved settlements</span>
                  <span className="font-semibold text-white">{currency(data?.summary.approved_settlements ?? 0)}</span>
                </li>
                <li className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                  <span>Paid settlements</span>
                  <span className="font-semibold text-white">{currency(data?.summary.paid_settlements ?? 0)}</span>
                </li>
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Campaigns &amp; Escalations</CardTitle>
              <CardDescription>Marketing load and critical ticket pressure touching merchants.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3 text-sm text-slate-300">
                <li className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                  <span>Active campaigns</span>
                  <span className="font-semibold text-white">{data?.summary.active_campaigns ?? 0}</span>
                </li>
                <li className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                  <span>Queued campaigns</span>
                  <span className="font-semibold text-white">{data?.summary.queued_campaigns ?? 0}</span>
                </li>
                <li className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                  <span>Critical tickets</span>
                  <span className="font-semibold text-white">{data?.summary.critical_tickets ?? 0}</span>
                </li>
              </ul>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Top Merchants by Gross Sales</CardTitle>
            <CardDescription>Ranked providers with fulfillment posture and the recommended next operator action.</CardDescription>
          </CardHeader>
          <CardContent>
            {query.isLoading ? (
              <p className="text-sm text-slate-400">Loading merchant performance…</p>
            ) : (data?.merchants ?? []).length === 0 ? (
              <p className="text-sm text-slate-400">
                No merchants are onboarded yet. Once service providers are registered and verified, their sales, fulfillment rate, and next actions will appear here.
              </p>
            ) : (
              <ul className="space-y-3 text-sm text-slate-300">
                {(data?.merchants ?? []).map((merchant) => (
                  <li key={merchant.id} className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-white">{merchant.business_name}</span>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">{merchant.status}</Badge>
                        <Badge variant="outline">{merchant.verification_status}</Badge>
                      </div>
                    </div>
                    <div className="mt-2 grid gap-1 text-slate-400 md:grid-cols-3">
                      <span>Orders: {merchant.order_count}</span>
                      <span>Gross sales: {currency(merchant.gross_sales)}</span>
                      <span>Fulfillment rate: {merchant.fulfillment_rate}%</span>
                    </div>
                    <p className="mt-2 leading-6 text-slate-400">{merchant.next_action}</p>
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
