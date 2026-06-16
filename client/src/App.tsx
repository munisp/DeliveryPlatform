import { FormEvent, useState } from "react";
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
  const [email, setEmail] = useState("admin@switchos.local");
  const [password, setPassword] = useState("ChangeMe123!");

  const loginMutation = useMutation({
    mutationFn: async ({ email, password }: { email: string; password: string }) => {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errorMessage = typeof payload?.error === "string" ? payload.error : "Unable to establish operator session.";
        throw new Error(errorMessage);
      }

      return payload as { redirect?: string };
    },
    onSuccess(payload) {
      window.location.href = payload.redirect || "/dashboard";
    },
  });

  const devSessionMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/auth/dev-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ role: "admin" }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errorMessage = typeof payload?.error === "string" ? payload.error : "Unable to establish development operator session.";
        throw new Error(errorMessage);
      }

      return payload as { redirect?: string };
    },
    onSuccess(payload) {
      window.location.href = payload.redirect || "/dashboard";
    },
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    loginMutation.mutate({ email, password });
  };

  return (
    <div className="min-h-screen bg-slate-950 px-6 py-16 text-slate-100 lg:px-12">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="space-y-4">
          <div className="text-sm uppercase tracking-[0.3em] text-cyan-300">Secure operator access</div>
          <h1 className="text-4xl font-semibold tracking-tight">Portal access now supports managed operator credentials.</h1>
          <p className="max-w-2xl text-lg leading-8 text-slate-300">
            The platform now supports persistent credential-backed operator login backed by signed sessions. For local recovery and validation environments, the seeded operator account remains available until an external identity provider is connected.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Operator sign in</CardTitle>
            <CardDescription>
              Use the seeded operator account or the credentials provisioned in the deployment environment. Replace the default bootstrap password before production use.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form className="space-y-4" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-200" htmlFor="operator-email">Email</label>
                <input
                  id="operator-email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-200" htmlFor="operator-password">Password</label>
                <input
                  id="operator-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400"
                />
              </div>
              <button
                type="submit"
                disabled={loginMutation.isPending}
                className="inline-flex rounded-full bg-cyan-500 px-5 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loginMutation.isPending ? "Signing in..." : "Enter operator dashboard"}
              </button>
            </form>
            {loginMutation.isError ? (
              <p className="text-sm text-rose-300">{loginMutation.error.message}</p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Non-production fallback</CardTitle>
            <CardDescription>
              This fallback remains available only for local validation. It should be disabled in production in favor of managed credentials or an external identity provider.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <button
              type="button"
              onClick={() => devSessionMutation.mutate()}
              disabled={devSessionMutation.isPending}
              className="inline-flex rounded-full border border-cyan-400/30 bg-cyan-500/10 px-5 py-3 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {devSessionMutation.isPending ? "Creating fallback session..." : "Use local validation session"}
            </button>
            {devSessionMutation.isError ? (
              <p className="text-sm text-rose-300">{devSessionMutation.error.message}</p>
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
