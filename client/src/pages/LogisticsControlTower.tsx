import { PackageCheck } from "lucide-react";

import PlatformSummaryPage from "@/components/PlatformSummaryPage";
import { trpc } from "@/lib/trpc";

export default function LogisticsControlTower() {
  const { data, isLoading } = trpc.localCommerceSuperGateway.logisticsControlTower.useQuery({ city: "Lagos" });

  const metrics = [
    {
      label: "Gateway status",
      value: data?.gateway?.status ?? "unknown",
      supporting: `${data?.gateway?.recent_plan_count ?? 0} plans recorded in the latest local control window.`,
    },
    {
      label: "Network resilience",
      value: data?.network?.resilience_band ?? "unknown",
      supporting: `${data?.network?.critical_nodes ?? 0} critical nodes and ${data?.network?.constrained_nodes ?? 0} constrained nodes.`,
    },
    {
      label: "Unified memberships",
      value: data?.workspace?.summary?.unified_memberships ?? 0,
      supporting: "Cross-category loyalty demand that can shift supply pressure across logistics lanes.",
    },
    {
      label: "Workspace categories",
      value: data?.workspace?.category_map?.length ?? 0,
      supporting: "Retail, travel, mobility, and concierge lanes currently available in the local control surface.",
    },
  ];

  const highlights = [
    data?.summary ?? "No logistics synthesis is available yet.",
    ...(data?.alerts ?? []),
    ...((data?.mobile_shortcuts ?? []).map((shortcut) => `${shortcut.label} · ${shortcut.route} · ${shortcut.action}`)),
  ];

  const sections = [
    {
      title: "Supply Network Health",
      description: "Multi-node resilience signals assembled from the retail forecasting layer.",
      items: data?.network?.nodes ?? [],
    },
    {
      title: "Middleware Readiness",
      description: "Fan-out and workflow targets that the control tower depends on during live logistics execution.",
      items: data?.gateway?.middleware ? [data.gateway.middleware] : [],
    },
    {
      title: "Control Tower Recommendations",
      description: "Operator actions synthesized from the gateway and logistics resilience signals.",
      items: data?.gateway?.recommendations ?? [],
    },
    {
      title: "Concierge Category Map",
      description: "Category breadth that can influence supply and fulfillment planning across the platform.",
      items: data?.workspace?.category_map ?? [],
    },
  ];

  return (
    <PlatformSummaryPage
      title="Logistics Control Tower"
      description="A cross-category supply-chain workspace that merges gateway readiness, warehouse resilience, and mobile-friendly next actions for live local-commerce operations."
      badge="Supply-chain execution"
      icon={PackageCheck}
      metrics={metrics}
      highlights={highlights}
      sections={sections}
      loading={isLoading}
    />
  );
}
