import React, {
  ComponentProps,
  ComponentType,
  FormEvent,
  Suspense,
  lazy,
  useMemo,
  useState,
} from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, Redirect, Route, Switch } from "wouter";
import { RefreshCw } from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import { ErrorBoundary } from "@/components/ErrorBoundary";

/**
 * Perf wave W4 (audit finding 15): every workspace page is code-split behind
 * React.lazy and each route renders inside its own <Suspense> boundary, so
 * the initial bundle only carries the shell (DashboardLayout stays eager).
 */
function RouteLoadingFallback() {
  return (
    <div
      className="flex min-h-[40vh] items-center justify-center"
      role="status"
      aria-label="Loading workspace"
    >
      <RefreshCw className="h-6 w-6 animate-spin text-cyan-400" />
      <span className="sr-only">Loading workspace…</span>
    </div>
  );
}

function lazyRoute<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): ComponentType<ComponentProps<T>> {
  const Component = lazy(factory);
  return function LazyRouteComponent(props: ComponentProps<T>) {
    return (
      <Suspense fallback={<RouteLoadingFallback />}>
        <Component {...props} />
      </Suspense>
    );
  };
}

const Analytics = lazyRoute(() => import("@/pages/Analytics"));
const DriverMobility = lazyRoute(() => import("@/pages/DriverMobility"));
const DriverOfferFairness = lazyRoute(
  () => import("@/pages/DriverOfferFairness"),
);
const CourierPortal = lazyRoute(() => import("@/pages/CourierPortal"));
const FieldServiceOperations = lazyRoute(
  () => import("@/pages/FieldServiceOperations"),
);
const DeveloperPlatform = lazyRoute(() => import("@/pages/DeveloperPlatform"));
const CommerceFulfillment = lazyRoute(
  () => import("@/pages/CommerceFulfillment"),
);
const VehicleAccessOperations = lazyRoute(
  () => import("@/pages/VehicleAccessOperations"),
);
const StakeholderVerification = lazyRoute(
  () => import("@/pages/StakeholderVerification"),
);
const LogisticsControlTower = lazyRoute(
  () => import("@/pages/LogisticsControlTower"),
);
const LogisticsOperations = lazyRoute(
  () => import("@/pages/LogisticsOperations"),
);
const ComplianceReview = lazyRoute(() => import("@/pages/ComplianceReview"));
const VerticalCompliance = lazyRoute(
  () => import("@/pages/VerticalCompliance"),
);
const PartnerIntegrations = lazyRoute(
  () => import("@/pages/PartnerIntegrations"),
);
const FinancialOperations = lazyRoute(
  () => import("@/pages/FinancialOperations"),
);
const TablesideCommerce = lazyRoute(() => import("@/pages/TablesideCommerce"));
const WhiteLabelApps = lazyRoute(() => import("@/pages/WhiteLabelApps"));
const MerchantChannels = lazyRoute(() => import("@/pages/MerchantChannels"));
const ServiceRecovery = lazyRoute(() => import("@/pages/ServiceRecovery"));
const MobilityOverview = lazyRoute(() => import("@/pages/MobilityOverview"));
const RiderApp = lazyRoute(() => import("@/pages/RiderApp"));
const BusinessTravel = lazyRoute(() => import("@/pages/BusinessTravel"));
const FreightOperations = lazyRoute(() => import("@/pages/FreightOperations"));
const HealthcareTransport = lazyRoute(
  () => import("@/pages/HealthcareTransport"),
);
const MerchantHub = lazyRoute(() => import("@/pages/MerchantHub"));
const CheckoutInsights = lazyRoute(() => import("@/pages/CheckoutInsights"));
const CourierTripRadar = lazyRoute(() => import("@/pages/CourierTripRadar"));
const TrustConsole = lazyRoute(() => import("@/pages/TrustConsole"));
const WorkerCouncil = lazyRoute(() => import("@/pages/WorkerCouncil"));
const DeactivationAppeals = lazyRoute(
  () => import("@/pages/DeactivationAppeals"),
);
const DriverSafetyCenter = lazyRoute(() => import("@/pages/DriverSafetyCenter"));
const MarketEconomics = lazyRoute(() => import("@/pages/MarketEconomics"));
const ExperimentConsole = lazyRoute(() => import("@/pages/ExperimentConsole"));
const MerchantAdsStudio = lazyRoute(() => import("@/pages/MerchantAdsStudio"));
const MerchantCommercePortal = lazyRoute(
  () => import("@/pages/MerchantCommercePortal"),
);
const PhoneOrderingStudio = lazyRoute(
  () => import("@/pages/PhoneOrderingStudio"),
);
const ConsumerOrders = lazyRoute(() => import("@/pages/ConsumerOrders"));
const ConsumerOrderDetail = lazyRoute(
  () => import("@/pages/ConsumerOrderDetail"),
);
const ConsumerSupport = lazyRoute(() => import("@/pages/ConsumerSupport"));
const ConsumerWallet = lazyRoute(() => import("@/pages/ConsumerWallet"));
const TenantAdminActions = lazyRoute(() => import("@/pages/TenantAdminActions"));
const SecurityProfilePage = lazyRoute(() => import("@/pages/SecurityProfile"));
const SecurityBlockedPage = lazyRoute(() =>
  import("@/pages/SecurityProfile").then((module) => ({
    default: module.SecurityBlockedPage,
  })),
);
const FinancialAdministration = lazyRoute(
  () => import("@/pages/FinancialAdministration"),
);
const CustomerDeliveryTracking = lazyRoute(() =>
  import("@/pages/DeliveryExperience").then((module) => ({
    default: module.CustomerDeliveryTracking,
  })),
);
const DriverProofOfDelivery = lazyRoute(() =>
  import("@/pages/DeliveryExperience").then((module) => ({
    default: module.DriverProofOfDelivery,
  })),
);
const FinancialTopologyPage = lazyRoute(() =>
  import("@/pages/DeliveryExperience").then((module) => ({
    default: module.FinancialTopologyPage,
  })),
);
const SignupPage = lazyRoute(() =>
  import("@/pages/AccountLifecycle").then((module) => ({
    default: module.SignupPage,
  })),
);
const VerifyEmailPage = lazyRoute(() =>
  import("@/pages/AccountLifecycle").then((module) => ({
    default: module.VerifyEmailPage,
  })),
);
const PasswordResetPage = lazyRoute(() =>
  import("@/pages/AccountLifecycle").then((module) => ({
    default: module.PasswordResetPage,
  })),
);
const InvitationAcceptancePage = lazyRoute(() =>
  import("@/pages/AccountLifecycle").then((module) => ({
    default: module.InvitationAcceptancePage,
  })),
);
const OnboardingPage = lazyRoute(() =>
  import("@/pages/AccountLifecycle").then((module) => ({
    default: module.OnboardingPage,
  })),
);
const InviteTeamPage = lazyRoute(() =>
  import("@/pages/AccountLifecycle").then((module) => ({
    default: module.InviteTeamPage,
  })),
);
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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
    title: "My Account",
    href: "/account",
    description:
      "Consumer surface: track your orders live, open and follow disputes, and review your wallet and payment ledger.",
  },
  {
    title: "Driver Mobility",
    href: "/driver-mobility",
    description:
      "Dispatch pressure, driver supply operations, and assignment readiness for live mobility execution.",
  },
  {
    title: "Tableside Commerce",
    href: "/tableside-commerce",
    description:
      "In-venue ordering, kitchen pacing, and hospitality execution for merchant dining channels.",
  },
  {
    title: "White-Label Apps",
    href: "/white-label-apps",
    description:
      "Merchant-owned channels, branded app rollout, and tenant distribution operations.",
  },
  {
    title: "Analytics",
    href: "/analytics",
    description:
      "Lakehouse-backed marketplace analytics, supply hotspots, and operator response visibility.",
  },
  {
    title: "Commerce Fulfillment",
    href: "/commerce-fulfillment",
    description:
      "Review signed Medusa order handoffs and progress retail or food delivery fulfillment.",
  },
  {
    title: "Developer Platform",
    href: "/developer-platform",
    description:
      "Issue provider-scoped API keys, register signed webhooks, and manage external integration access.",
  },
  {
    title: "Field Service",
    href: "/field-service",
    description:
      "Schedule service work, assign qualified technicians, and follow immutable job-completion evidence.",
  },
  {
    title: "Transparent Driver Offers",
    href: "/driver-offers",
    description:
      "Review pickup burden, destination, platform commission, rider verification, and expected proceeds before accepting or fairly declining a ride offer.",
  },
  {
    title: "Worker Council",
    href: "/council",
    description:
      "Respond to tabled policy consultations within their SLA and track whether platform commitments were activated.",
  },
  {
    title: "Deactivation Appeals",
    href: "/appeals",
    description:
      "See your 14-day deactivation notice timeline, file an appeal, and (for operators) record decisions with rationale.",
  },
  {
    title: "Vehicle Access",
    href: "/vehicle-access",
    description:
      "Manage verified low-cost vehicle access for gig workers with authoritative contracts and inspection evidence.",
  },
  {
    title: "Stakeholder Verification",
    href: "/verification",
    description:
      "Record consented verification evidence, processor status, provider checks, and accountable human review.",
  },
  {
    title: "Logistics Control Tower",
    href: "/logistics-control-tower",
    description:
      "Supply resilience, warehouse risk, middleware readiness, and operator shortcuts for live logistics execution.",
  },
  {
    title: "Logistics Operations",
    href: "/logistics-operations",
    description:
      "Tenant-scoped jobs, service zones, state-controlled work execution, tracking evidence, and signed partner events.",
  },
  {
    title: "Compliance Review",
    href: "/compliance-review",
    description:
      "Auditable driver and vehicle evidence verification, mandatory reviewer decisions, expiry reconciliation, and dispatch eligibility.",
  },
  {
    title: "Partner Integrations",
    href: "/partner-integrations",
    description:
      "Tenant-scoped API credentials, explicit scopes, HMAC-signed inbound events, replay protection, and revocation controls.",
  },
  {
    title: "Financial Operations",
    href: "/financial-operations",
    description:
      "Invoice issuance, payment-dispute lifecycle, audit evidence, and durable governed reporting.",
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

  return (await response.json()) as AuthConfig;
}

function HomePage() {
  return (
    <div className="min-h-screen bg-slate-950 px-6 py-16 text-slate-100 lg:px-12">
      <div className="mx-auto max-w-6xl space-y-10">
        <div className="space-y-4">
          <div className="text-sm uppercase tracking-[0.3em] text-cyan-300">
            SwitchOS
          </div>
          <h1 className="max-w-4xl text-4xl font-semibold tracking-tight lg:text-6xl">
            Multi-vertical commerce, logistics, and operator tooling aligned
            around durable operational workflows.
          </h1>
          <p className="max-w-3xl text-lg leading-8 text-slate-300">
            The operator experience now focuses on the actively connected
            workspaces that have real backend coverage for analytics, mobility,
            merchant channels, and recovery operations.
          </p>
          <div className="flex flex-wrap gap-3 pt-2">
            <Link
              href="/dashboard"
              className="rounded-full bg-cyan-500 px-5 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-400"
            >
              Open operator dashboard
            </Link>
            <Link
              href="/analytics"
              className="rounded-full border border-slate-700 px-5 py-3 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:bg-slate-900"
            >
              Review analytics workspace
            </Link>
            <Link
              href="/portal"
              className="rounded-full border border-cyan-400/30 bg-cyan-500/10 px-5 py-3 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/20"
            >
              Operator portal
            </Link>
            <Link
              href="/signup"
              className="rounded-full border border-slate-700 px-5 py-3 text-sm font-medium text-slate-100 transition hover:border-cyan-400/40 hover:bg-slate-900"
            >
              Create organization
            </Link>
            <Link
              href="/account"
              className="rounded-full border border-amber-400/30 bg-amber-500/10 px-5 py-3 text-sm font-medium text-amber-100 transition hover:bg-amber-500/20"
            >
              My account — orders, support, wallet
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
  const portalError =
    typeof window !== "undefined"
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
    mutationFn: async ({
      email,
      password,
    }: {
      email: string;
      password: string;
    }) => {
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
        const errorMessage =
          typeof payload?.error === "string"
            ? payload.error
            : "Unable to establish operator session.";
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
          <div className="text-sm uppercase tracking-[0.3em] text-cyan-300">
            Secure operator access
          </div>
          <h1 className="text-4xl font-semibold tracking-tight">
            Operator portal
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-slate-300">
            {authModeLabel}
          </p>
        </div>

        {authConfigQuery.isError ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-rose-300">
                Unable to load authentication configuration.
              </p>
            </CardContent>
          </Card>
        ) : null}

        {portalError ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-rose-300">
                Authentication error: {portalError}
              </p>
            </CardContent>
          </Card>
        ) : null}

        {externalEnabled ? (
          <Card>
            <CardHeader>
              <CardTitle>External OIDC sign in</CardTitle>
              <CardDescription>
                Start a real browser-based authorization-code login against the
                configured identity provider.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/5 p-4 text-sm text-slate-300">
                <p>
                  Issuer:{" "}
                  <span className="text-slate-100">
                    {authConfig?.oidcIssuer || "Not configured"}
                  </span>
                </p>
                <p>
                  Client:{" "}
                  <span className="text-slate-100">
                    {authConfig?.oidcClientId || "Not configured"}
                  </span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  const startPath =
                    authConfig?.oidcStartPath || "/api/auth/oidc/start";
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
                Use the seeded operator account or the credentials provisioned
                in the deployment environment. Replace the bootstrap password
                before any production exposure.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <form className="space-y-4" onSubmit={handleSubmit}>
                <div className="space-y-2">
                  <label
                    className="text-sm font-medium text-slate-200"
                    htmlFor="operator-email"
                  >
                    Email
                  </label>
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
                  <label
                    className="text-sm font-medium text-slate-200"
                    htmlFor="operator-password"
                  >
                    Password
                  </label>
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
                  {loginMutation.isPending
                    ? "Signing in..."
                    : "Enter operator dashboard"}
                </button>
                <p className="text-center text-sm text-slate-400">
                  <Link
                    href="/reset-password"
                    className="font-medium text-cyan-300 hover:text-cyan-200"
                  >
                    Forgot password?
                  </Link>
                </p>
              </form>
              {loginMutation.isError ? (
                <p className="text-sm text-rose-300">
                  {loginMutation.error.message}
                </p>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {authConfig?.selfServiceSignupEnabled ? (
          <p className="text-center text-sm text-slate-400">
            New to SwitchOS?{" "}
            <Link
              href="/signup"
              className="font-medium text-cyan-300 hover:text-cyan-200"
            >
              Create an organization
            </Link>
          </p>
        ) : null}
      </div>
    </div>
  );
}

function DashboardPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-white">
            Control Center
          </h1>
          <p className="mt-2 max-w-3xl text-slate-400">
            The operator shell is focused on the connected domains that
            currently have verified backend coverage and persisted operational
            data.
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
                <Link
                  href={item.href}
                  className="inline-flex rounded-full border border-cyan-400/30 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/20"
                >
                  Open workspace
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Team access</CardTitle>
            <CardDescription>
              Invite colleagues with a role tailored to this tenant.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/team/invite"
              className="inline-flex rounded-full border border-cyan-400/30 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/20"
            >
              Invite team member
            </Link>
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
        <h1 className="text-3xl font-semibold text-white">
          Workspace not found
        </h1>
        <p className="max-w-2xl text-slate-400">
          This route is outside the currently connected operator workspaces.
        </p>
        <Link
          href="/dashboard"
          className="inline-flex rounded-full border border-cyan-400/30 bg-cyan-500/10 px-5 py-3 text-sm font-medium text-cyan-100"
        >
          Return to dashboard
        </Link>
      </div>
    </DashboardLayout>
  );
}

export default function App() {
  return (
    <ErrorBoundary variant="app" section="application">
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
      <Route
        path="/driver/proof-of-delivery"
        component={DriverProofOfDelivery}
      />
      <Route path="/security/blocked" component={SecurityBlockedPage} />
      <Route path="/dashboard" component={DashboardPage} />
      <Route path="/analytics" component={Analytics} />
      <Route path="/driver-mobility" component={DriverMobility} />
      <Route path="/driver-offers" component={DriverOfferFairness} />
      <Route path="/courier-portal" component={CourierPortal} />
      <Route path="/field-service" component={FieldServiceOperations} />
      <Route path="/vehicle-access" component={VehicleAccessOperations} />
      <Route path="/verification" component={StakeholderVerification} />
      <Route path="/developer-platform" component={DeveloperPlatform} />
      <Route path="/commerce-fulfillment" component={CommerceFulfillment} />
      <Route
        path="/logistics-control-tower"
        component={LogisticsControlTower}
      />
      <Route path="/logistics-operations" component={LogisticsOperations} />
      <Route path="/compliance-review" component={ComplianceReview} />
      <Route path="/compliance/vertical-packs" component={VerticalCompliance} />
      <Route path="/partner-integrations" component={PartnerIntegrations} />
      <Route path="/financial-operations" component={FinancialOperations} />
      <Route path="/tableside-commerce" component={TablesideCommerce} />
      <Route path="/white-label-apps" component={WhiteLabelApps} />
      <Route path="/merchant-channels" component={MerchantChannels} />
      <Route path="/merchant-commerce" component={MerchantCommercePortal} />
      <Route path="/service-recovery" component={ServiceRecovery} />
      <Route path="/consoles/merchant-hub" component={MerchantHub} />
      <Route path="/consoles/checkout" component={CheckoutInsights} />
      <Route path="/consoles/courier-radar" component={CourierTripRadar} />
      <Route path="/consoles/trust" component={TrustConsole} />
      <Route path="/council" component={WorkerCouncil} />
      <Route path="/appeals" component={DeactivationAppeals} />
      <Route path="/safety" component={DriverSafetyCenter} />
      <Route path="/market-economics" component={MarketEconomics} />
      <Route path="/consoles/experiments" component={ExperimentConsole} />
      <Route path="/consoles/merchant-ads" component={MerchantAdsStudio} />
      <Route path="/phone-ordering-studio" component={PhoneOrderingStudio} />
      <Route path="/mobility" component={MobilityOverview} />
      <Route path="/mobility/rider" component={RiderApp} />
      <Route path="/mobility/business" component={BusinessTravel} />
      <Route path="/mobility/freight" component={FreightOperations} />
      <Route path="/mobility/healthcare" component={HealthcareTransport} />
      <Route path="/account/orders/:orderId" component={ConsumerOrderDetail} />
      <Route path="/account/orders" component={ConsumerOrders} />
      <Route path="/account/support" component={ConsumerSupport} />
      <Route path="/account/wallet" component={ConsumerWallet} />
      <Route path="/account">
        <Redirect to="/account/orders" />
      </Route>
        <Route component={NotFoundPage} />
      </Switch>
    </ErrorBoundary>
  );
}
