import PlatformSummaryPage from "@/components/PlatformSummaryPage";
import { trpc } from "@/lib/trpc";
import { UtensilsCrossed } from "lucide-react";

export default function TablesideCommerce() {
  const query = trpc.tablesideOrdering.summary.useQuery({ limit: 8 });
  const data = query.data;

  return (
    <PlatformSummaryPage
      title="Tableside Commerce"
      description="Run dine-in QR ordering, staff-assisted checkout, hospitality menus, pickup conversion, and cross-channel customer identity from a unified tableside surface."
      badge="Hospitality channels"
      icon={UtensilsCrossed}
      loading={query.isLoading}
      error={query.error?.message}
      metrics={[
        { label: "QR Venues", value: data?.summary?.qr_venues ?? 0, supporting: "Locations enabled for tableside or QR-based ordering." },
        { label: "Active Sessions", value: data?.summary?.active_sessions ?? 0, supporting: "Dining sessions currently moving through scan, order, or pay flows." },
        { label: "Pay-at-Table Enablement", value: data?.summary?.pay_at_table_enablement ?? 0, supporting: "Share of the rollout capable of table-side payment completion." },
        { label: "Upsell Modules", value: data?.summary?.upsell_modules ?? 0, supporting: data?.summary?.recommended_action },
      ]}
      highlights={data?.order_modes ?? []}
      sections={[
        {
          title: "Order Modes",
          description: "Hospitality experiences supported through tableside and hybrid ordering.",
          items: data?.order_modes ?? [],
        },
        {
          title: "Venue Rollout",
          description: "Representative venue launch and dining-room readiness records.",
          items: data?.venue_rollout ?? [],
        },
      ]}
    />
  );
}
