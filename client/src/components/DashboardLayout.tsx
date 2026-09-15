import { type ReactNode, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  AppWindow,
  BarChart3,
  Bike,
  Briefcase,
  CarFront,
  ChevronRight,
  ClipboardCheck,
  Code2,
  FlaskConical,
  Gauge,
  Handshake,
  HeartPulse,
  Landmark,
  Scale,
  LayoutDashboard,
  Map,
  Megaphone,
  Menu,
  PackageCheck,
  Percent,
  PhoneCall,
  Radar,
  ShieldCheck,
  Siren,
  ShoppingBag,
  Store,
  Truck,
  UserRound,
  UsersRound,
  UtensilsCrossed,
  X,
} from "lucide-react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { type OperatorRole, useSessionProfile } from "@/lib/sessionProfile";

type NavigationItem = {
  icon: typeof LayoutDashboard;
  label: string;
  path: string;
  allowedRoles: OperatorRole[];
  requiresMfa?: boolean;
};

type NavigationGroup = {
  label: string;
  items: NavigationItem[];
};

const allOperatorRoles: OperatorRole[] = [
  "viewer",
  "operator",
  "ops",
  "admin",
  "platform_admin",
  "super_admin",
];
const operationsRoles: OperatorRole[] = [
  "operator",
  "ops",
  "admin",
  "platform_admin",
  "super_admin",
];
const administratorRoles: OperatorRole[] = [
  "admin",
  "platform_admin",
  "super_admin",
];

const navigationGroups: NavigationGroup[] = [
  {
    label: "Overview",
    items: [
      {
        icon: LayoutDashboard,
        label: "Control Center",
        path: "/dashboard",
        allowedRoles: allOperatorRoles,
      },
      {
        icon: BarChart3,
        label: "Analytics",
        path: "/analytics",
        allowedRoles: allOperatorRoles,
      },
    ],
  },
  {
    label: "Mobility & field work",
    items: [
      {
        icon: CarFront,
        label: "Driver Mobility",
        path: "/driver-mobility",
        allowedRoles: operationsRoles,
      },
      {
        icon: CarFront,
        label: "Driver Offers",
        path: "/driver-offers",
        allowedRoles: operationsRoles,
      },
      {
        icon: CarFront,
        label: "Vehicle Access",
        path: "/vehicle-access",
        allowedRoles: operationsRoles,
      },
      {
        icon: Truck,
        label: "Field Service",
        path: "/field-service",
        allowedRoles: operationsRoles,
      },
      {
        icon: ShieldCheck,
        label: "Compliance Review",
        path: "/compliance-review",
        allowedRoles: operationsRoles,
      },
      {
        icon: ShieldCheck,
        label: "Stakeholder Verification",
        path: "/verification",
        allowedRoles: operationsRoles,
      },
    ],
  },
  {
    label: "Mobility",
    items: [
      {
        icon: Map,
        label: "Mobility Overview",
        path: "/mobility",
        allowedRoles: operationsRoles,
      },
      {
        icon: Bike,
        label: "Rider App",
        path: "/mobility/rider",
        allowedRoles: operationsRoles,
      },
      {
        icon: Briefcase,
        label: "Business Travel",
        path: "/mobility/business",
        allowedRoles: operationsRoles,
      },
      {
        icon: Truck,
        label: "Freight Operations",
        path: "/mobility/freight",
        allowedRoles: operationsRoles,
      },
      {
        icon: HeartPulse,
        label: "Healthcare Transport",
        path: "/mobility/healthcare",
        allowedRoles: operationsRoles,
      },
      {
        icon: Radar,
        label: "Courier Trip Radar",
        path: "/consoles/courier-radar",
        allowedRoles: operationsRoles,
      },
    ],
  },
  {
    label: "Operator consoles",
    items: [
      {
        icon: ShieldCheck,
        label: "Trust Console",
        path: "/consoles/trust",
        allowedRoles: operationsRoles,
      },
      {
        icon: FlaskConical,
        label: "Experiment Console",
        path: "/consoles/experiments",
        allowedRoles: operationsRoles,
      },
      {
        icon: ClipboardCheck,
        label: "Vertical Compliance",
        path: "/compliance/vertical-packs",
        allowedRoles: operationsRoles,
      },
      {
        icon: Gauge,
        label: "Checkout Insights",
        path: "/consoles/checkout",
        allowedRoles: operationsRoles,
      },
      {
        icon: Megaphone,
        label: "Merchant Ads Studio",
        path: "/consoles/merchant-ads",
        allowedRoles: operationsRoles,
      },
    ],
  },
  {
    label: "Logistics control",
    items: [
      {
        icon: Truck,
        label: "Logistics Operations",
        path: "/logistics-operations",
        allowedRoles: operationsRoles,
      },
      {
        icon: PackageCheck,
        label: "Control Tower",
        path: "/logistics-control-tower",
        allowedRoles: operationsRoles,
      },
      {
        icon: ShieldCheck,
        label: "Service Recovery",
        path: "/service-recovery",
        allowedRoles: operationsRoles,
      },
    ],
  },
  {
    label: "Commerce",
    items: [
      {
        icon: UtensilsCrossed,
        label: "Tableside Commerce",
        path: "/tableside-commerce",
        allowedRoles: operationsRoles,
      },
      {
        icon: PackageCheck,
        label: "Commerce Fulfillment",
        path: "/commerce-fulfillment",
        allowedRoles: operationsRoles,
      },
      {
        icon: Store,
        label: "Merchant Channels",
        path: "/merchant-channels",
        allowedRoles: operationsRoles,
      },
      {
        icon: Store,
        label: "Merchant Hub",
        path: "/consoles/merchant-hub",
        allowedRoles: operationsRoles,
      },
      {
        icon: ShoppingBag,
        label: "Merchant Portal",
        path: "/merchant-commerce",
        allowedRoles: operationsRoles,
      },
      {
        icon: PhoneCall,
        label: "Phone Ordering",
        path: "/phone-ordering-studio",
        allowedRoles: operationsRoles,
      },
      {
        icon: AppWindow,
        label: "White-Label Apps",
        path: "/white-label-apps",
        allowedRoles: administratorRoles,
      },
    ],
  },
  {
    label: "Administration",
    items: [
      {
        icon: Code2,
        label: "Developer Platform",
        path: "/developer-platform",
        allowedRoles: administratorRoles,
      },
      {
        icon: UsersRound,
        label: "Partner Integrations",
        path: "/partner-integrations",
        allowedRoles: administratorRoles,
      },
      {
        icon: UsersRound,
        label: "Tenant Administration",
        path: "/tenant-admin",
        allowedRoles: administratorRoles,
      },
      {
        icon: Landmark,
        label: "Financial Operations",
        path: "/financial-operations",
        allowedRoles: administratorRoles,
      },
      {
        icon: Landmark,
        label: "Financial Administration",
        path: "/admin/finance",
        allowedRoles: administratorRoles,
        requiresMfa: true,
      },
      {
        icon: Percent,
        label: "Market Economics",
        path: "/market-economics",
        allowedRoles: administratorRoles,
      },
      {
        icon: ShieldCheck,
        label: "Security Settings",
        path: "/profile/security",
        allowedRoles: allOperatorRoles,
      },
    ],
  },
  {
    label: "Self-serve",
    items: [
      {
        icon: UserRound,
        label: "Courier Portal",
        path: "/courier-portal",
        allowedRoles: allOperatorRoles,
      },
      {
        icon: Handshake,
        label: "Worker Council",
        path: "/council",
        allowedRoles: allOperatorRoles,
      },
      {
        icon: Scale,
        label: "Deactivation Appeals",
        path: "/appeals",
        allowedRoles: allOperatorRoles,
      },
      {
        icon: Siren,
        label: "Driver Safety",
        path: "/safety",
        allowedRoles: allOperatorRoles,
      },
    ],
  },
];

const navigationItems = navigationGroups.flatMap((group) => group.items);

function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function isActivePath(location: string, path: string) {
  return location === path || location.startsWith(`${path}/`);
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sessionProfile = useSessionProfile();
  const profile = sessionProfile.data;
  const currentRole = profile?.role ?? null;

  const visibleGroups = useMemo(() => {
    if (!currentRole) {
      return navigationGroups
        .map((group) => ({
          ...group,
          items: group.items.filter(
            (item) => item.path === "/profile/security",
          ),
        }))
        .filter((group) => group.items.length > 0);
    }

    return navigationGroups
      .map((group) => ({
        ...group,
        items: group.items.filter(
          (item) =>
            item.allowedRoles.includes(currentRole) &&
            (!item.requiresMfa || profile?.mfaAuthenticated),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [currentRole, profile?.mfaAuthenticated]);

  const activeItem = useMemo(
    () =>
      navigationItems.find((item) => isActivePath(location, item.path)) ??
      navigationGroups[0].items[0],
    [location],
  );
  const activeRoute = navigationItems.find((item) =>
    isActivePath(location, item.path),
  );
  const activeRouteAllowed = Boolean(
    activeRoute &&
    currentRole &&
    activeRoute.allowedRoles.includes(currentRole) &&
    (!activeRoute.requiresMfa || profile?.mfaAuthenticated),
  );
  const shouldRenderChildren = !activeRoute || activeRouteAllowed;

  const navigate = (path: string) => {
    setSidebarOpen(false);
    setLocation(path);
  };

  const sessionLabel = sessionProfile.isLoading
    ? "Verifying session"
    : !profile
      ? "Sign-in required"
      : profile.mfaAuthenticated
        ? `${profile.role ?? "operator"} · MFA verified`
        : `${profile.role ?? "operator"} · MFA needed`;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="flex min-h-screen">
        <aside
          aria-label="Operator workspace navigation"
          className={cn(
            "fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-slate-800 bg-slate-950/95 p-4 backdrop-blur transition-transform duration-200 ease-out lg:static lg:translate-x-0",
            sidebarOpen
              ? "translate-x-0"
              : "-translate-x-full lg:translate-x-0",
          )}
        >
          <div className="mb-5 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-[0.24em] text-cyan-300">
                SwitchOS
              </div>
              <div className="mt-1 text-lg font-semibold">
                Operator Workspaces
              </div>
            </div>
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setSidebarOpen(false)}
              className="rounded-md p-2 text-slate-300 transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-400 lg:hidden"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mb-5 rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-4">
            <div className="text-sm font-medium text-cyan-100">
              Operational access
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              Navigation reflects the active authenticated role. Service and
              database authorization remain the source of truth for every
              operation.
            </p>
            <div className="mt-3 inline-flex max-w-full items-center gap-1.5 rounded-full border border-slate-700 bg-slate-950/60 px-2.5 py-1 text-xs text-slate-300">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
              <span className="truncate">{sessionLabel}</span>
            </div>
          </div>

          <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
            {visibleGroups.map((group) => (
              <section key={group.label} aria-label={group.label}>
                <h2 className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  {group.label}
                </h2>
                <div className="space-y-1">
                  {group.items.map((item) => {
                    const active = isActivePath(location, item.path);
                    return (
                      <button
                        key={item.path}
                        type="button"
                        aria-current={active ? "page" : undefined}
                        onClick={() => navigate(item.path)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition focus:outline-none focus:ring-2 focus:ring-cyan-400",
                          active
                            ? "bg-cyan-500/15 text-cyan-100 ring-1 ring-cyan-400/40"
                            : "text-slate-300 hover:bg-slate-900 hover:text-white",
                        )}
                      >
                        <item.icon className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">
                          {item.label}
                        </span>
                        {active ? (
                          <ChevronRight className="h-4 w-4 shrink-0" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </nav>
        </aside>

        {sidebarOpen ? (
          <button
            type="button"
            aria-label="Close navigation overlay"
            onClick={() => setSidebarOpen(false)}
            className="fixed inset-0 z-30 bg-slate-950/70 lg:hidden"
          />
        ) : null}

        <div className="flex min-h-screen min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/85 backdrop-blur">
            <div className="flex items-center justify-between gap-4 px-4 py-4 lg:px-8">
              <div className="flex min-w-0 items-center gap-3">
                <button
                  type="button"
                  aria-label="Open navigation"
                  onClick={() => setSidebarOpen(true)}
                  className="rounded-md p-2 text-slate-300 transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-400 lg:hidden"
                >
                  <Menu className="h-4 w-4" />
                </button>
                <div className="min-w-0">
                  <div className="text-xs uppercase tracking-[0.24em] text-slate-500">
                    Active workspace
                  </div>
                  <div className="truncate text-lg font-semibold text-white">
                    {activeItem.label}
                  </div>
                </div>
              </div>

              <div className="hidden shrink-0 rounded-full border border-slate-800 bg-slate-900 px-4 py-2 text-sm text-slate-300 sm:block">
                {profile?.tenantId
                  ? "Tenant-scoped access"
                  : "Session-scoped access"}
              </div>
            </div>
          </header>

          <main className="flex-1 px-4 py-6 lg:px-8">
            {shouldRenderChildren ? (
              <ErrorBoundary variant="section" section={activeItem.label}>
                {children}
              </ErrorBoundary>
            ) : (
              <section className="mx-auto max-w-2xl rounded-2xl border border-amber-500/30 bg-amber-950/20 p-6">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
                  <div>
                    <h1 className="text-lg font-semibold text-amber-100">
                      {activeRoute?.requiresMfa && currentRole
                        ? "MFA verification required"
                        : "Workspace access restricted"}
                    </h1>
                    <p className="mt-2 text-sm leading-6 text-amber-100/80">
                      {activeRoute?.requiresMfa && currentRole
                        ? "This financial workspace becomes available after MFA is verified for the current authenticated session."
                        : "This workspace is not available for the active role. Navigation visibility is a convenience control; every API and database operation remains independently authorized."}
                    </p>
                    <button
                      type="button"
                      onClick={() => navigate("/profile/security")}
                      className="mt-4 inline-flex rounded-lg border border-amber-300/30 px-3 py-2 text-sm font-medium text-amber-100 transition hover:bg-amber-500/10 focus:outline-none focus:ring-2 focus:ring-amber-300"
                    >
                      Review security settings
                    </button>
                  </div>
                </div>
              </section>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
