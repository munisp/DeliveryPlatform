import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { TrendingUp, DollarSign, Package, Users, Loader2, Radar, AlertTriangle } from "lucide-react";
import { LineChart, Line, BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

const revenueData = [
  { month: "Jan", revenue: 4500, orders: 120 },
  { month: "Feb", revenue: 5200, orders: 145 },
  { month: "Mar", revenue: 4800, orders: 132 },
  { month: "Apr", revenue: 6100, orders: 168 },
  { month: "May", revenue: 7200, orders: 195 },
  { month: "Jun", revenue: 6800, orders: 182 },
];

const ordersByVertical = [
  { vertical: "Laundry", orders: 450, revenue: 12500 },
  { vertical: "Pharmacy", orders: 320, revenue: 8900 },
  { vertical: "Grocery", orders: 280, revenue: 7200 },
  { vertical: "Food", orders: 510, revenue: 15800 },
];

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

  const stats = [
    { title: "Total Revenue", value: "€42,580", change: "+12.5%", icon: DollarSign, color: "text-green-500" },
    { title: "Total Orders", value: orderStats?.total || 0, change: "+8.2%", icon: Package, color: "text-blue-500" },
    { title: "Active Drivers", value: driverStats?.online || 0, change: "+5.1%", icon: Users, color: "text-purple-500" },
    { title: "Avg Order Value", value: "€28.50", change: "+3.8%", icon: TrendingUp, color: "text-orange-500" },
  ];

  if (loadingSummary || loadingOrders || loadingDrivers || loadingMarketplace) {
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
                <p className="text-xs font-medium text-green-500">{stat.change} from last month</p>
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
            <CardDescription>Daily order count over the last 6 months</CardDescription>
          </CardHeader>
          <CardContent>
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
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
