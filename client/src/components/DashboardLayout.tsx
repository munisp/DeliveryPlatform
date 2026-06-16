import { Menu, X, LayoutDashboard, BarChart3, CarFront, UtensilsCrossed, AppWindow, ShieldCheck, Store, PhoneCall } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useLocation } from "wouter";

const menuItems = [
  { icon: LayoutDashboard, label: "Control Center", path: "/dashboard" },
  { icon: BarChart3, label: "Analytics", path: "/analytics" },
  { icon: CarFront, label: "Driver Mobility", path: "/driver-mobility" },
  { icon: UtensilsCrossed, label: "Tableside Commerce", path: "/tableside-commerce" },
  { icon: AppWindow, label: "White-Label Apps", path: "/white-label-apps" },
  { icon: Store, label: "Merchant Channels", path: "/merchant-channels" },
  { icon: PhoneCall, label: "Phone Ordering", path: "/phone-ordering" },
  { icon: ShieldCheck, label: "Service Recovery", path: "/service-recovery" },
];

function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const activeItem = useMemo(
    () => menuItems.find((item) => item.path === location) ?? menuItems[0],
    [location],
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="flex min-h-screen">
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-40 w-72 border-r border-slate-800 bg-slate-950/95 p-4 backdrop-blur transition-transform lg:static lg:translate-x-0",
            sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
          )}
        >
          <div className="mb-6 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-[0.24em] text-cyan-300">SwitchOS</div>
              <div className="mt-1 text-lg font-semibold">Operator Workspaces</div>
            </div>
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="rounded-md p-2 text-slate-300 hover:bg-slate-800 lg:hidden"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mb-6 rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-4">
            <div className="text-sm font-medium text-cyan-100">Operational focus</div>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              This rebuilt shell prioritizes the domains that were previously orphaned or summary-only and gives them a connected control plane.
            </p>
          </div>

          <nav className="space-y-1">
            {menuItems.map((item) => {
              const active = item.path === activeItem.path;
              return (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => {
                    setSidebarOpen(false);
                    setLocation(item.path);
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm transition",
                    active
                      ? "bg-cyan-500/15 text-cyan-100 ring-1 ring-cyan-400/40"
                      : "text-slate-300 hover:bg-slate-900 hover:text-white",
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="flex min-h-screen flex-1 flex-col lg:pl-0">
          <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950/85 backdrop-blur">
            <div className="flex items-center justify-between px-4 py-4 lg:px-8">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setSidebarOpen(true)}
                  className="rounded-md p-2 text-slate-300 hover:bg-slate-800 lg:hidden"
                >
                  <Menu className="h-4 w-4" />
                </button>
                <div>
                  <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Active workspace</div>
                  <div className="text-lg font-semibold text-white">{activeItem.label}</div>
                </div>
              </div>

              <div className="rounded-full border border-slate-800 bg-slate-900 px-4 py-2 text-sm text-slate-300">
                End-to-end rebuild in progress
              </div>
            </div>
          </header>

          <main className="flex-1 px-4 py-6 lg:px-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
