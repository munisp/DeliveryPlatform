import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

const currency = (value: number) =>
  `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const dateLabel = (value: string | Date | null | undefined) =>
  value ? new Date(value).toLocaleString() : "—";

export default function MerchantAdsStudio() {
  const query = trpc.consoles.merchantAds.useQuery();
  const data = query.data;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="space-y-3">
          <Badge variant="secondary">Operations console</Badge>
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">Merchant Ads Studio</h1>
            <p className="mt-2 max-w-3xl text-slate-400">
              Sponsored placement performance, campaign spend, and bid guidance for merchant demand capture.
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
              <CardDescription>Sponsored Merchants</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.sponsored_merchants ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Avg Bid Multiplier</CardDescription>
              <CardTitle className="text-3xl">×{data?.summary.avg_bid_multiplier ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Loyalty Velocity</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.loyalty_velocity ?? 0}</CardTitle>
            </CardHeader>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Ads Recommendation</CardTitle>
            <CardDescription>Portfolio-level guidance for sponsored ranking and lifecycle offers.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-7 text-slate-300">
              {data?.summary.recommendation ?? "Loading ads guidance…"}
            </p>
          </CardContent>
        </Card>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Merchant Ranking</CardTitle>
              <CardDescription>Providers ranked by ad rank score with recommended bid multipliers.</CardDescription>
            </CardHeader>
            <CardContent>
              {query.isLoading ? (
                <p className="text-sm text-slate-400">Loading merchant ranking…</p>
              ) : (data?.merchant_ranking ?? []).length === 0 ? (
                <p className="text-sm text-slate-400">
                  No merchants are eligible for sponsored placement yet. Ranked providers and bid guidance will appear here once providers generate order history.
                </p>
              ) : (
                <ul className="space-y-3 text-sm text-slate-300">
                  {(data?.merchant_ranking ?? []).map((merchant) => (
                    <li key={merchant.id} className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-white">{merchant.name}</span>
                        <div className="flex items-center gap-2">
                          {merchant.sponsored_slot ? <Badge>Sponsored slot</Badge> : null}
                        </div>
                      </div>
                      <div className="mt-2 grid gap-1 text-slate-400 md:grid-cols-2">
                        <span>{merchant.category ?? "General"} · rating {merchant.rating}</span>
                        <span>Orders: {merchant.order_count} · revenue {currency(merchant.revenue)}</span>
                        <span>Ad rank score: {merchant.ad_rank_score}</span>
                        <span>Bid multiplier: ×{merchant.recommended_bid_multiplier}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Campaigns</CardTitle>
              <CardDescription>Marketing campaigns with budget consumption and ROI estimate.</CardDescription>
            </CardHeader>
            <CardContent>
              {query.isLoading ? (
                <p className="text-sm text-slate-400">Loading campaigns…</p>
              ) : (data?.campaigns ?? []).length === 0 ? (
                <p className="text-sm text-slate-400">
                  No marketing campaigns exist yet. Create campaigns to start sponsored placement and track spend here.
                </p>
              ) : (
                <ul className="space-y-3 text-sm text-slate-300">
                  {(data?.campaigns ?? []).map((campaign) => (
                    <li key={campaign.id} className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-white">{campaign.name}</span>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">{campaign.channel ?? "multi-channel"}</Badge>
                          <Badge variant="secondary">{campaign.status}</Badge>
                        </div>
                      </div>
                      <div className="mt-2 grid gap-1 text-slate-400 md:grid-cols-2">
                        <span>Budget: {currency(campaign.budget)}</span>
                        <span>Spent: {currency(campaign.spent)}</span>
                        <span>ROI estimate: ×{campaign.roi_estimate}</span>
                        <span>
                          {dateLabel(campaign.starts_at)} → {dateLabel(campaign.ends_at)}
                        </span>
                      </div>
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
