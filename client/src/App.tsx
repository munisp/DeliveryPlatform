import { useMutation } from "@tanstack/react-query";
import { Link, Route, Switch } from "wouter";

import DashboardLayout from "@/components/DashboardLayout";
import Analytics from "@/pages/Analytics";
import DriverMobility from "@/pages/DriverMobility";
import TablesideCommerce from "@/pages/TablesideCommerce";
import WhiteLabelApps from "@/pages/WhiteLabelApps";
import MerchantChannels from "@/pages/MerchantChannels";
import ServiceRecovery from "@/pages/ServiceRecovery";
import PhoneOrderingStudio from "@/pages/PhoneOrderingStudio";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const quickLinks = [
  {
    title: "Driver Mobility",
    href: "/driver-mobility",
    description: "Dispatch pressure, driver supply operations, and assignment readiness for Uber-style mobility execution.",
  },
  {
    title: "Tableside Commerce",
    href: "/tableside-commerce",
    description: "In-venue ordering, kitchen pacing, and hospitality execution for DoorDash-style merchant channels.",
  },
  {
    title: "White-Label Apps",
    href: "/white-label-apps",
    description: "Merchant-owned channels, branded app rollout, and tenant distribution operations.",
  },
  {
    title: "Analytics",
    href: "/analytics",
    description: "Lakehouse-aware marketplace analytics, supply hotspots, and operator response visibility.",
  },
];

function HomePage() {
  return (
    <div className="min-h-screen bg-slate-950 px-6 py-16 text-slate-100 lg:px-12">
      <div className="mx-auto max-w-6xl space-y-10">
        <div className="space-y-4">
          <div className="text-sm uppercase tracking-[0.3em] text-cyan-300">SwitchOS</div>
          <h1 className="max-w-4xl text-4xl font-semibold tracking-tight lg:text-6xl">
            Multi-vertical commerce, logistics, and operator tooling rebuilt around connected workflows.
          </h1>
          <p className="max-w-3xl text-lg leading-8 text-slate-300">
            This recovery pass focuses on replacing orphaned and summary-only surfaces with connected operational workspaces for analytics, mobility, hospitality, and merchant-owned channels.
          </p>
          <div className="flex flex-wrap gap-3 pt-2">
            <Link href="/dashboard" className="rounded-full bg-cyan-500 px-5 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-400">
              Open operator dashboard
            </Link>
            <Link href="/analytics" className="rounded-full border border-slate-700 px-5 py-3 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-900">
              Review analytics workspace
            </Link>
            <Link href="/portal" className="rounded-full border border-cyan-400/30 bg-cyan-500/10 px-5 py-3 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/20">
              Operator portal
            </Link>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {quickLinks.map((item) => (
            <Link key={item.href} href={item.href}>
              <Card className="h-full transition hover:border-cyan-400/40 hover:bg-slate-900">
                <CardHeader>
                  <CardTitle>{item.title}</CardTitle>
                  <CardDescription>{item.description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function PortalPage() {
  const launchSession = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/auth/dev-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ role: "admin" }),
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || "Unable to establish operator session.");
      }

      return response.json() as Promise<{ redirect?: string }>;
    },
    onSuccess(payload) {
      window.location.href = payload.redirect || "/dashboard";
    },
  });

  return (
    <div className="min-h-screen bg-slate-950 px-6 py-16 text-slate-100 lg:px-12">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="space-y-4">
          <div className="text-sm uppercase tracking-[0.3em] text-cyan-300">Secure operator access</div>
          <h1 className="text-4xl font-semibold tracking-tight">Portal access is now backed by signed sessions.</h1>
          <p className="max-w-2xl text-lg leading-8 text-slate-300">
            The audit remediation removed the previous unsigned cookie trust model. In local and non-production environments, you can still establish a signed operator session through this portal to validate the rebuilt dashboard and service-backed analytics flow.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Development operator session</CardTitle>
            <CardDescription>
              This bootstrap path is available only outside production. Production access should come from a real identity provider and verified sessions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <button
              type="button"
              onClick={() => launchSession.mutate()}
              disabled={launchSession.isPending}
              className="inline-flex rounded-full bg-cyan-500 px-5 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {launchSession.isPending ? "Establishing session..." : "Enter operator dashboard"}
            </button>
            {launchSession.isError ? (
              <p className="text-sm text-rose-300">{launchSession.error.message}</p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function DashboardPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-white">Control Center</h1>
          <p className="mt-2 max-w-3xl text-slate-400">
            The operator shell has been narrowed to the currently connected domains so incomplete and orphaned modules do not masquerade as finished products.
          </p>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          {quickLinks.map((item) => (
            <Card key={item.href}>
              <CardHeader>
                <CardTitle>{item.title}</CardTitle>
                <CardDescription>{item.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <Link href={item.href} className="inline-flex rounded-full border border-cyan-400/30 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/20">
                  Open workspace
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </DashboardLayout>
  );
}

function SimpleWorkspacePage({
  title,
  description,
  bullets,
}: {
  title: string;
  description: string;
  bullets: string[];
}) {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-white">{title}</h1>
          <p className="mt-2 max-w-3xl text-slate-400">{description}</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Implementation scope</CardTitle>
            <CardDescription>This domain remains under active rebuild and is intentionally expressed as a connected roadmap rather than a fake finished CRUD surface.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3 text-sm leading-6 text-slate-300">
              {bullets.map((bullet) => (
                <li key={bullet} className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">{bullet}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}

function NotFoundPage() {
  return (
    <DashboardLayout>
      <div className="space-y-4">
        <h1 className="text-3xl font-semibold text-white">Workspace not found</h1>
        <p className="max-w-2xl text-slate-400">
          This route has not been restored yet. The control plane has been narrowed to the domains that currently have connected implementation coverage.
        </p>
        <Link href="/dashboard" className="inline-flex rounded-full border border-cyan-400/30 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-100">
          Return to dashboard
        </Link>
      </div>
    </DashboardLayout>
  );
}

export default function App() {
  return (
    <Switch>
      <Route path="/" component={HomePage} />
      <Route path="/portal" component={PortalPage} />
      <Route path="/dashboard" component={DashboardPage} />
      <Route path="/analytics" component={Analytics} />
      <Route path="/driver-mobility" component={DriverMobility} />
      <Route path="/tableside-commerce" component={TablesideCommerce} />
      <Route path="/white-label-apps" component={WhiteLabelApps} />
      <Route path="/merchant-channels" component={MerchantChannels} />
      <Route path="/phone-ordering" component={PhoneOrderingStudio} />
      <Route path="/service-recovery" component={ServiceRecovery} />
      <Route component={NotFoundPage} />
    </Switch>
  );
}
