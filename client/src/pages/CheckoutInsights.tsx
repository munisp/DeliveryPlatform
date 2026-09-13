import DashboardLayout from "@/components/DashboardLayout";
import { QueryErrorState } from "@/components/QueryState";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

const currency = (value: number) =>
  `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const dateLabel = (value: string | Date | null | undefined) =>
  value ? new Date(value).toLocaleString() : "—";

export default function CheckoutInsights() {
  const query = trpc.consoles.checkoutSummary.useQuery();
  const data = query.data;

  if (query.isError) {
    return (
      <DashboardLayout>
        <div className="space-y-6">
          <QueryErrorState
            resource="checkout insights data"
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
            <h1 className="text-3xl font-semibold tracking-tight text-white">Checkout Insights</h1>
            <p className="mt-2 max-w-3xl text-slate-400">
              Conversion levers across memberships, loyalty rewards, recommended merchants, live checkout orders, and payment incidents.
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-5">
          <Card>
            <CardHeader>
              <CardDescription>Active Memberships</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.active_memberships ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Available Rewards</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.available_rewards ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Payment Failures</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.payment_failures ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Reorder-Ready Orders</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.reorder_ready_orders ?? 0}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Avg Recommended ETA</CardDescription>
              <CardTitle className="text-3xl">{data?.summary.avg_recommended_eta ?? 0} min</CardTitle>
            </CardHeader>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Conversion Recommendation</CardTitle>
            <CardDescription>Guidance derived from the current membership, reward, and payment reliability posture.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-7 text-slate-300">
              {data?.summary.cart_conversion_recommendation ?? "Loading checkout guidance…"}
            </p>
          </CardContent>
        </Card>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Memberships</CardTitle>
              <CardDescription>Consumer membership plans ordered by upcoming renewal.</CardDescription>
            </CardHeader>
            <CardContent>
              {query.isLoading ? (
                <p className="text-sm text-slate-400">Loading memberships…</p>
              ) : (data?.memberships ?? []).length === 0 ? (
                <p className="text-sm text-slate-400">
                  No consumer memberships exist yet. Membership plans and savings will appear here once customers subscribe.
                </p>
              ) : (
                <ul className="space-y-3 text-sm text-slate-300">
                  {(data?.memberships ?? []).map((membership) => (
                    <li key={membership.id} className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-white">{membership.plan_name}</span>
                        <Badge variant="secondary">{membership.status}</Badge>
                      </div>
                      <div className="mt-2 grid gap-1 text-slate-400 md:grid-cols-2">
                        <span>Price: {currency(membership.monthly_price)}/mo</span>
                        <span>Cashback: {membership.cashback_rate}%</span>
                        <span>Fee discount: {currency(membership.delivery_fee_discount)}</span>
                        <span>Savings YTD: {currency(membership.savings_ytd)}</span>
                      </div>
                      <p className="mt-2 text-slate-500">Renews: {dateLabel(membership.renewal_at)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Loyalty Rewards</CardTitle>
              <CardDescription>Redeemable rewards ordered by points required.</CardDescription>
            </CardHeader>
            <CardContent>
              {query.isLoading ? (
                <p className="text-sm text-slate-400">Loading rewards…</p>
              ) : (data?.rewards ?? []).length === 0 ? (
                <p className="text-sm text-slate-400">
                  No loyalty rewards are configured yet. Add rewards to give checkout customers redemption options.
                </p>
              ) : (
                <ul className="space-y-3 text-sm text-slate-300">
                  {(data?.rewards ?? []).map((reward) => (
                    <li key={reward.id} className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                      <div>
                        <p className="font-semibold text-white">{reward.reward_name}</p>
                        <p className="text-slate-400">
                          {reward.points_required} pts · {currency(reward.reward_value)} value · expires {dateLabel(reward.expires_at)}
                        </p>
                      </div>
                      <Badge variant="secondary">{reward.status}</Badge>
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
              <CardTitle>Recommended Merchants</CardTitle>
              <CardDescription>Top-rated providers surfaced for checkout placement.</CardDescription>
            </CardHeader>
            <CardContent>
              {query.isLoading ? (
                <p className="text-sm text-slate-400">Loading merchant recommendations…</p>
              ) : (data?.recommended_merchants ?? []).length === 0 ? (
                <p className="text-sm text-slate-400">
                  No merchants are available to recommend yet. Onboard and rate providers to populate checkout recommendations.
                </p>
              ) : (
                <ul className="space-y-3 text-sm text-slate-300">
                  {(data?.recommended_merchants ?? []).map((merchant) => (
                    <li key={merchant.id} className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-white">{merchant.name}</span>
                        <div className="flex items-center gap-2">
                          {merchant.sponsored ? <Badge>Sponsored</Badge> : null}
                          <Badge variant="secondary">{merchant.status}</Badge>
                        </div>
                      </div>
                      <p className="mt-2 text-slate-400">
                        {merchant.category ?? "General"} · rating {merchant.rating} · ETA {merchant.eta_minutes} min · basket boost {merchant.basket_boost}%
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Checkout Orders</CardTitle>
              <CardDescription>Recently updated orders with basket readiness and reorder likelihood.</CardDescription>
            </CardHeader>
            <CardContent>
              {query.isLoading ? (
                <p className="text-sm text-slate-400">Loading checkout orders…</p>
              ) : (data?.checkout_orders ?? []).length === 0 ? (
                <p className="text-sm text-slate-400">
                  No orders have been placed yet. Live checkout orders and reorder signals will appear here once customers start ordering.
                </p>
              ) : (
                <ul className="space-y-3 text-sm text-slate-300">
                  {(data?.checkout_orders ?? []).map((order) => (
                    <li key={order.id} className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-white">Order #{order.id}</span>
                        <div className="flex items-center gap-2">
                          {order.basket_ready ? <Badge variant="outline">Basket ready</Badge> : null}
                          <Badge variant="secondary">{order.status}</Badge>
                        </div>
                      </div>
                      <p className="mt-2 text-slate-400">
                        {currency(order.total_amount)} · ETA {order.eta_minutes} min · reorder likelihood {(order.reorder_likelihood * 100).toFixed(0)}%
                      </p>
                      <p className="mt-1 text-slate-500">{order.delivery_address ?? "Address on file"} · updated {dateLabel(order.updated_at)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Payment Incidents</CardTitle>
            <CardDescription>Recent payments, refunds, and chargebacks affecting checkout reliability.</CardDescription>
          </CardHeader>
          <CardContent>
            {query.isLoading ? (
              <p className="text-sm text-slate-400">Loading payment incidents…</p>
            ) : (data?.payment_incidents ?? []).length === 0 ? (
              <p className="text-sm text-slate-400">
                No payment incidents recorded. Failed payments, refunds, and chargebacks will be listed here when they occur.
              </p>
            ) : (
              <ul className="space-y-3 text-sm text-slate-300">
                {(data?.payment_incidents ?? []).map((incident) => (
                  <li key={incident.id} className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                    <div>
                      <p className="font-semibold text-white">{incident.type}</p>
                      <p className="text-slate-400">{currency(incident.amount)} · {dateLabel(incident.created_at)}</p>
                    </div>
                    <Badge variant={incident.status === "failed" ? "destructive" : "secondary"}>{incident.status}</Badge>
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
