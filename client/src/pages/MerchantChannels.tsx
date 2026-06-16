import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

export default function MerchantChannels() {
  const query = trpc.merchantChannels.workspace.useQuery();
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
      </div>
    </DashboardLayout>
  );
}
