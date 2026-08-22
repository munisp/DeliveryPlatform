import React, { FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, Route, Switch } from "wouter";

import DashboardLayout from "@/components/DashboardLayout";
import Analytics from "@/pages/Analytics";
import DriverMobility from "@/pages/DriverMobility";
import LogisticsControlTower from "@/pages/LogisticsControlTower";
import TablesideCommerce from "@/pages/TablesideCommerce";
import WhiteLabelApps from "@/pages/WhiteLabelApps";
import MerchantChannels from "@/pages/MerchantChannels";
import ServiceRecovery from "@/pages/ServiceRecovery";
import PhoneOrderingStudio from "@/pages/PhoneOrderingStudio";
import TenantAdminActions from "@/pages/TenantAdminActions";
import SecurityProfilePage, { SecurityBlockedPage } from "@/pages/SecurityProfile";
import FinancialAdministration from "@/pages/FinancialAdministration";
import { CustomerDeliveryTracking, DriverProofOfDelivery, FinancialTopologyPage } from "@/pages/DeliveryExperience";
import { InvitationAcceptancePage, InviteTeamPage, OnboardingPage, PasswordResetPage, SignupPage, VerifyEmailPage } from "@/pages/AccountLifecycle";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type AuthConfig = {
  externalOidcEnabled: boolean;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  oidcLogoutUrl: string | null;
  oidcStartPath: string | null;
  fallbackLoginEnabled: boolean;
  selfServiceSignupEnabled: boolean;
};

const quickLinks = [
  {
    title: "Driver Mobility",
    href: "/driver-mobility",
    description: "Dispatch pressure, driver supply operations, and assignment readiness for live mobility execution.",
  },
  {
    title: "Tableside Commerce",
    href: "/tableside-commerce",
    description: "In-venue ordering, kitchen pacing, and hospitality execution for merchant dining channels.",
  },
  {
    title: "White-Label Apps",
    href: "/white-label-apps",
    description: "Merchant-owned channels, branded app rollout, and tenant distribution operations.",
  },
  {
    title: "Analytics",
    href: "/analytics",
    description: "Lakehouse-backed marketplace analytics, supply hotspots, and operator response visibility.",
  },
  {
    title: "Logistics Control Tower",
    href: "/logistics-control-tower",
    description: "Supply resilience, warehouse risk, middleware readiness, and operator shortcuts for live logistics execution.",
  },
];

async function fetchAuthConfig(): Promise<AuthConfig> {
  const response = await fetch("/api/auth/config", {
    credentials: "include",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Unable to load authentication configuration.");
  }

  return await response.json() as AuthConfig;
}

function HomePage() {
  return (
    <div className="min-h-screen bg-slate-950 px-6 py-16 text-slate-100 lg:px-12">
      <div className="mx-auto max-w-6xl space-y-10">
        <div className="space-y-4">
          <div className="text-sm uppercase tracking-[0.3em] text-cyan-300">SwitchOS</div>
          <h1 className="max-w-4xl text-4xl font-semibold tracking-tight lg:text-6xl">
            Multi-vertical commerce, logistics, and operator tooling aligned around durable operational workflows.
          </h1>
          <p className="max-w-3xl text-lg leading-8 text-slate-300">
            The operator experience now focuses on the actively connected workspaces that have real backend coverage for analytics, mobility, merchant channels, and recovery operations.
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
            <Link href="/signup" className="rounded-full border border-slate-700 px-5 py-3 text-sm font-medium text-slate-100 transition hover:border-cyan-400/40 hover:bg-slate-900">
              Create organization
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
  const portalError = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("error")
    : null;

  const authConfigQuery = useQuery({
    queryKey: ["auth-config"],
    queryFn: fetchAuthConfig,
    staleTime: 60_000,
  });

  const authConfig = authConfigQuery.data;
  const externalEnabled = authConfig?.externalOidcEnabled ?? false;
  const fallbackLoginEnabled = authConfig?.fallbackLoginEnabled ?? true;

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

  const authModeLabel = useMemo(() => {
    if (externalEnabled) {
      return "External identity is enabled for this environment through a browser-based OIDC login flow.";
    }
    return "Local credential-backed sign-in remains available for environments that have not yet enabled external identity.";
  }, [externalEnabled]);

  return (
    <div className="min-h-screen bg-slate-950 px-6 py-16 text-slate-100 lg:px-12">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="space-y-4">
          <div className="text-sm uppercase tracking-[0.3em] text-cyan-300">Secure operator access</div>
          <h1 className="text-4xl font-semibold tracking-tight">Operator portal</h1>
          <p className="max-w-2xl text-lg leading-8 text-slate-300">
            {authModeLabel}
          </p>
        </div>

        {authConfigQuery.isError ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-rose-300">Unable to load authentication configuration.</p>
            </CardContent>
          </Card>
        ) : null}

        {portalError ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-rose-300">Authentication error: {portalError}</p>
            </CardContent>
          </Card>
        ) : null}

        {externalEnabled ? (
          <Card>
            <CardHeader>
              <CardTitle>External OIDC sign in</CardTitle>
              <CardDescription>
                Start a real browser-based authorization-code login against the configured identity provider.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/5 p-4 text-sm text-slate-300">
                <p>Issuer: <span className="text-slate-100">{authConfig?.oidcIssuer || "Not configured"}</span></p>
                <p>Client: <span className="text-slate-100">{authConfig?.oidcClientId || "Not configured"}</span></p>
              </div>
              <button
                type="button"
                onClick={() => {
                  const startPath = authConfig?.oidcStartPath || "/api/auth/oidc/start";
                  window.location.href = `${startPath}?returnTo=${encodeURIComponent("/dashboard")}`;
                }}
                className="inline-flex rounded-full bg-cyan-500 px-5 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-400"
              >
                Continue with external identity
              </button>
            </CardContent>
          </Card>
        ) : null}

        {fallbackLoginEnabled ? (
          <Card>
            <CardHeader>
              <CardTitle>Managed operator sign in</CardTitle>
              <CardDescription>
                Use the seeded operator account or the credentials provisioned in the deployment environment. Replace the bootstrap password before any production exposure.
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
                <p className="text-center text-sm text-slate-400"><Link href="/reset-password" className="font-medium text-cyan-300 hover:text-cyan-200">Forgot password?</Link></p>
              </form>
              {loginMutation.isError ? (
                <p className="text-sm text-rose-300">{loginMutation.error.message}</p>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {!externalEnabled && fallbackLoginEnabled ? (
          <Card>
            <CardHeader>
              <CardTitle>Non-production fallback</CardTitle>
              <CardDescription>
                This fallback remains available only for local validation. It should stay disabled whenever production OIDC is active.
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
        ) : null}
        {authConfig?.selfServiceSignupEnabled ? <p className="text-center text-sm text-slate-400">New to SwitchOS? <Link href="/signup" className="font-medium text-cyan-300 hover:text-cyan-200">Create an organization</Link></p> : null}
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
            The operator shell is focused on the connected domains that currently have verified backend coverage and persisted operational data.
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
        <Card>
          <CardHeader><CardTitle>Team access</CardTitle><CardDescription>Invite colleagues with a role tailored to this tenant.</CardDescription></CardHeader>
          <CardContent><Link href="/team/invite" className="inline-flex rounded-full border border-cyan-400/30 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/20">Invite team member</Link></CardContent>
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
          This route is outside the currently connected operator workspaces.
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
      <Route path="/signup" component={SignupPage} />
      <Route path="/verify-email" component={VerifyEmailPage} />
      <Route path="/reset-password" component={PasswordResetPage} />
      <Route path="/accept-invitation" component={InvitationAcceptancePage} />
      <Route path="/onboarding" component={OnboardingPage} />
      <Route path="/team/invite" component={InviteTeamPage} />
      <Route path="/tenant-admin" component={TenantAdminActions} />
      <Route path="/profile/security" component={SecurityProfilePage} />
      <Route path="/admin/finance" component={FinancialAdministration} />
      <Route path="/admin/finance/topology" component={FinancialTopologyPage} />
      <Route path="/delivery/tracking" component={CustomerDeliveryTracking} />
      <Route path="/driver/proof-of-delivery" component={DriverProofOfDelivery} />
      <Route path="/security/blocked" component={SecurityBlockedPage} />
      <Route path="/dashboard" component={DashboardPage} />
      <Route path="/analytics" component={Analytics} />
      <Route path="/driver-mobility" component={DriverMobility} />
      <Route path="/logistics-control-tower" component={LogisticsControlTower} />
      <Route path="/tableside-commerce" component={TablesideCommerce} />
      <Route path="/white-label-apps" component={WhiteLabelApps} />
      <Route path="/merchant-channels" component={MerchantChannels} />
      <Route path="/service-recovery" component={ServiceRecovery} />
      <Route path="/phone-ordering-studio" component={PhoneOrderingStudio} />
      <Route component={NotFoundPage} />
    </Switch>
  );
}
