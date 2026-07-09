import PlatformSummaryPage from "@/components/PlatformSummaryPage";
import { trpc } from "@/lib/trpc";
import { CarFront } from "lucide-react";

export default function DriverMobility() {
  const query = trpc.driverMobility.summary.useQuery({ limit: 8 });
  const logisticsQuery = trpc.localCommerceSuperGateway.logisticsControlTower.useQuery({ city: "Lagos" });
  const data = query.data;

  return (
    <PlatformSummaryPage
      title="Driver Mobility"
      description="Operate a unified supply network where drivers can earn across passenger mobility, courier delivery, airport transfers, healthcare transport, and assisted logistics runs."
      badge="Supply operations"
      icon={CarFront}
      loading={query.isLoading}
      metrics={[
        { label: "Online Drivers", value: data?.summary?.online_drivers ?? 0, supporting: "Drivers currently available for multimodal assignments." },
        { label: "Trip Radar Candidates", value: data?.summary?.trip_radar_candidates ?? 0, supporting: "Supply pool eligible for longer or less certain work via marketplace-style assignment." },
        { label: "Airport-Ready Drivers", value: data?.summary?.airport_ready_drivers ?? 0, supporting: "Supply already staged for terminal, reserve, and transfer operations." },
        { label: "Avg Weekly Earnings", value: data?.summary?.avg_weekly_earnings ?? 0, supporting: data?.summary?.recommended_action },
      ]}
      highlights={[
        ...(data?.earning_streams ?? []),
        ...(data?.longcat?.rider_guidance ?? []),
        logisticsQuery.data?.summary ?? "Loading logistics control-tower summary…",
      ]}
      sections={[
        {
          title: "Supply Queue",
          description: "Live driver roster with mode, reliability, and earnings context.",
          items: data?.supply_queue ?? [],
        },
        {
          title: "LongCat Dispatch Brief",
          description: "Local AI guidance for real-time balancing, batching, and dispatch explainability.",
          items: [
            data?.longcat?.dispatch_brief ?? "Loading dispatch brief…",
            data?.longcat?.batching_strategy ?? "Loading batching strategy…",
          ],
        },
        {
          title: "Dispatch Risk Flags",
          description: "Operational risks and guardrails synthesized by the LongCat dispatch layer.",
          items: data?.longcat?.risk_flags ?? [],
        },
        {
          title: "Ranked Candidates",
          description: "Driver ranking summary derived from the embedded dispatch optimizer.",
          items: data?.longcat?.ranked_candidates ?? [],
        },
        {
          title: "Logistics Control Tower",
          description: "Supply-chain and warehouse resilience context that can change dispatch routing and ETA honesty.",
          items: logisticsQuery.data
            ? [
                logisticsQuery.data.summary,
                `Route: /logistics-control-tower · risk band ${logisticsQuery.data.network?.resilience_band ?? "unknown"} · critical nodes ${logisticsQuery.data.network?.critical_nodes ?? 0}`,
              ]
            : [],
        },
      ]}
    />
  );
}
