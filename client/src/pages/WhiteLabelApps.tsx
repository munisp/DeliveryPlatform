import PlatformSummaryPage from "@/components/PlatformSummaryPage";
import { trpc } from "@/lib/trpc";
import { AppWindow } from "lucide-react";

export default function WhiteLabelApps() {
  const query = trpc.whiteLabelApps.summary.useQuery({ limit: 8 });
  const data = query.data;

  return (
    <PlatformSummaryPage
      title="White-Label Apps"
      description="Launch branded rider, courier, and merchant mobile experiences with tenant-specific themes, reusable templates, governed release tracks, and support instrumentation."
      badge="Tenant distribution"
      icon={AppWindow}
      loading={query.isLoading}
      metrics={[
        { label: "Branded Apps Live", value: data?.summary?.branded_apps_live ?? 0, supporting: "Distinct customer-facing mobile brands currently configured or live." },
        { label: "Templates Available", value: data?.summary?.templates_available ?? 0, supporting: "Reusable app blueprints available to tailor each tenant experience." },
        { label: "Push Channels Ready", value: data?.summary?.push_channels_ready ?? 0, supporting: "Mobile messaging channels already wired for launch operations and support." },
        { label: "Release Tracks", value: data?.summary?.release_tracks ?? 0, supporting: data?.summary?.recommended_action },
      ]}
      highlights={(data?.app_templates ?? []).map((item) => `${item.name} · ${item.audience} · ${item.release_track}`)}
      sections={[
        {
          title: "App Templates",
          description: "Reusable launch-ready mobile templates for merchant, courier, rider, and enterprise programs.",
          items: data?.app_templates ?? [],
        },
        {
          title: "Brand Portfolio",
          description: "Representative brands and tenants ready for launch or already live.",
          items: data?.brands ?? [],
        },
      ]}
    />
  );
}
