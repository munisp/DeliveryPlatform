import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { TrendingUp, DollarSign, Package, Users, Loader2, Radar, AlertTriangle } from "lucide-react";
import { LineChart, Line, BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

function formatMonthLabel(month: string): string {
  const parsed = new Date(`${month}-01T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? month : parsed.toLocaleString(undefined, { month: "short" });
}

function formatCurrency(value: number): string {
  return `€${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function EmptyChartState({ message }: { message: string }) {
  return (
    <div className="flex h-[300px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function hotspotVariant(pressureBand: string): "default" | "secondary" | "destructive" | "outline" {
  if (pressureBand === "critical") return "destructive";
  if (pressureBand === "elevated") return "secondary";
  if (pressureBand === "balanced") return "default";
  return "outline";
}

export default function Analytics() {
  const { data: analyticsSummary, isLoading: loadingSummary } = trpc.analytics.summary.useQuery();
  const { data: orderStats, isLoading: loadingOrders } = trpc.analytics.orderStats.useQuery();
  const { data: driverStats, isLoading: loadingDrivers } = trpc.analytics.driverStats.useQuery();
  const { data: marketplaceOverview, isLoading: loadingMarketplace } = trpc.analytics.marketplaceOverview.useQuery();
  const { data: revenueTrend, isLoading: loadingRevenueTrend } = trpc.analytics.revenueTrend.useQuery();
  const { data: verticalBreakdown, isLoading: loadingVerticals } = trpc.analytics.ordersByVertical.useQuery();

  const totalRevenue = Number(orderStats?.revenue ?? 0) || 0;
  const totalOrders = Number(orderStats?.total ?? 0) || 0;
  const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

  const stats = [
    { title: "Total Revenue", value: formatCurrency(totalRevenue), icon: DollarSign, color: "text-green-500" },
    { title: "Total Orders", value: totalOrders, icon: Package, color: "text-blue-500" },
    { title: "Active Drivers", value: driverStats?.online || 0, icon: Users, color: "text-purple-500" },
    { title: "Avg Order Value", value: formatCurrency(avgOrderValue), icon: TrendingUp, color: "text-orange-500" },
  ];

  const revenueData = (revenueTrend ?? []).map((point) => ({
    month: formatMonthLabel(point.month),
    revenue: point.revenue,
    orders: point.orders,
  }));

  const ordersByVertical = (verticalBreakdown ?? []).map((point) => ({
    vertical: point.vertical,
    orders: point.orders,
    revenue: point.revenue,
  }));

  if (loadingSummary || loadingOrders || loadingDrivers || loadingMarketplace || loadingRevenueTrend || loadingVerticals) {
    return (
      <DashboardLayout>
        <div className="flex h-screen items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6 p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Analytics & Reporting</h1>
            <p className="text-muted-foreground">Comprehensive insights into platform performance, marketplace pressure, and operator response priorities.</p>
          </div>
          <div className="flex flex-col items-start gap-2 lg:items-end">
            <Badge variant={analyticsSummary?.source === "lakehouse" ? "default" : "secondary"}>
              {analyticsSummary?.source === "lakehouse" ? "Lakehouse-backed analytics" : "Database fallback analytics"}
            </Badge>
            <p className="text-xs text-muted-foreground">
              Last analytics refresh: {analyticsSummary?.generated_at ? new Date(analyticsSummary.generated_at).toLocaleString() : "pending"}
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          {stats.map((stat) => (
            <Card key={stat.title}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
                <stat.icon className={`h-4 w-4 ${stat.color}`} />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stat.value}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.2fr_2fr]">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Radar className="h-5 w-5" /> Marketplace Overview</CardTitle>
              <CardDescription>Queue pressure, supply health, and the operational signals that affect dispatch quality.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border p-3">
                  <div className="text-xs uppercase text-muted-foreground">Pending orders</div>
                  <div className="mt-1 text-2xl font-semibold">{marketplaceOverview?.queue?.pending_orders ?? 0}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-xs uppercase text-muted-foreground">Average queue minutes</div>
                  <div className="mt-1 text-2xl font-semibold">{Number(marketplaceOverview?.queue?.avg_queue_minutes ?? 0).toFixed(1)}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-xs uppercase text-muted-foreground">Available drivers</div>
                  <div className="mt-1 text-2xl font-semibold">{marketplaceOverview?.drivers?.available_drivers ?? 0}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-xs uppercase text-muted-foreground">Assignment events (7d)</div>
                  <div className="mt-1 text-2xl font-semibold">{marketplaceOverview?.activity_signals?.assignment_events_7d ?? 0}</div>
                </div>
              </div>

              <div className="space-y-3">
                {(marketplaceOverview?.hotspots ?? []).slice(0, 4).map((hotspot: any) => (
                  <div key={hotspot.zone_key} className="rounded-lg border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-medium">Zone {hotspot.zone_key}</div>
                        <div className="text-sm text-muted-foreground">
                          {hotspot.waiting_orders} waiting · {hotspot.available_drivers} available drivers · pressure {Number(hotspot.pressure_ratio ?? 0).toFixed(2)}
                        </div>
                      </div>
                      <Badge variant={hotspotVariant(hotspot.pressure_band)}>{hotspot.pressure_band}</Badge>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">{hotspot.recommended_action}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Revenue Trend</CardTitle>
              <CardDescription>Monthly revenue and order volume</CardDescription>
            </CardHeader>
            <CardContent>
              {revenueData.length === 0 ? (
                <EmptyChartState message="No revenue data available yet." />
              ) : (
              <ResponsiveContainer width="100%" height={320}>
                <AreaChart data={revenueData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="month" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Area type="monotone" dataKey="revenue" stroke="#8884d8" fill="#8884d8" fillOpacity={0.6} />
                </AreaChart>
              </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Orders by Vertical</CardTitle>
              <CardDescription>Distribution across service categories</CardDescription>
            </CardHeader>
            <CardContent>
              {ordersByVertical.length === 0 ? (
                <EmptyChartState message="No order data available by vertical yet." />
              ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={ordersByVertical}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="vertical" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="orders" fill="#8884d8" />
                </BarChart>
              </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5" /> Queue Hotspots</CardTitle>
              <CardDescription>The most supply-constrained areas in the marketplace right now.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {(marketplaceOverview?.hotspots ?? []).map((hotspot: any) => (
                <div key={hotspot.zone_key} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium">Zone {hotspot.zone_key}</div>
                    <Badge variant={hotspotVariant(hotspot.pressure_band)}>{hotspot.pressure_band}</Badge>
                  </div>
                  <div className="mt-2 grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
                    <div>Open orders: {hotspot.open_orders}</div>
                    <div>Waiting orders: {hotspot.waiting_orders}</div>
                    <div>Available drivers: {hotspot.available_drivers}</div>
                    <div>Avg wait: {Number(hotspot.avg_wait_minutes ?? 0).toFixed(1)} min</div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Order Volume Trend</CardTitle>
            <CardDescription>Monthly order count over the last 6 months</CardDescription>
          </CardHeader>
          <CardContent>
            {revenueData.length === 0 ? (
              <EmptyChartState message="No order volume data available yet." />
            ) : (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={revenueData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="orders" stroke="#82ca9d" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
