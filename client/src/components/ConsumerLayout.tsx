import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { LifeBuoy, Package, Wallet } from "lucide-react";

/**
 * Lightweight consumer-facing layout for the /account surface.
 *
 * Deliberately NOT the operator DashboardLayout: a simple header with brand
 * and account nav, mobile-first single column, low-saturation warm palette
 * (stone/amber on white) and generous whitespace.
 */

const navItems = [
  { href: "/account/orders", label: "Orders", icon: Package },
  { href: "/account/support", label: "Support", icon: LifeBuoy },
  { href: "/account/wallet", label: "Wallet", icon: Wallet },
];

export function ConsumerLayout({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const [location] = useLocation();

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <header className="border-b border-stone-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-4xl flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <Link href="/account/orders">
            <span className="text-lg font-semibold tracking-tight text-stone-900">
              DeliveryPlatform
              <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                My account
              </span>
            </span>
          </Link>
          <nav aria-label="Account" className="flex items-center gap-1">
            {navItems.map((item) => {
              const active =
                location === item.href || location.startsWith(`${item.href}/`);
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href}>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition ${
                      active
                        ? "bg-amber-100 text-amber-900"
                        : "text-stone-500 hover:bg-stone-100 hover:text-stone-800"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </span>
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-5 py-10">
        <div className="mb-8 space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-stone-900 sm:text-3xl">
            {title}
          </h1>
          {description ? (
            <p className="max-w-2xl text-sm leading-6 text-stone-500">
              {description}
            </p>
          ) : null}
        </div>
        {children}
      </main>
    </div>
  );
}
