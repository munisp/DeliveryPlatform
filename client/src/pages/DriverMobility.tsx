import PlatformSummaryPage from "@/components/PlatformSummaryPage";
import { trpc } from "@/lib/trpc";
import { CarFront } from "lucide-react";

type LogisticsTowerSummary = {
  summary?: string;
  network?: {
    resilience_band?: string;
    critical_nodes?: number;
    constrained_nodes?: number;
  };
};

export default function DriverMobility() {
  const query = trpc.driverMobility.summary.useQuery({ limit: 8 });
  const logisticsQuery = trpc.localCommerceSuperGateway.logisticsControlTower.useQuery({ city: "Lagos" });
  const logisticsTower = logisticsQuery.data as LogisticsTowerSummary | undefined;
  const data = query.data;

  return (
    <PlatformSummaryPage
      title="Driver Mobility"
      description="Operate a unified supply network where drivers can earn across passenger mobility, courier delivery, airport transfers, healthcare transport, and assisted logistics runs."
      badge="Supply operations"
      icon={CarFront}
      loading={query.isLoading}
      error={query.error?.message}
      metrics={[
        { label: "Online Drivers", value: data?.summary?.online_drivers ?? 0, supporting: "Drivers currently available for multimodal assignments." },
        { label: "Busy Drivers", value: data?.summary?.busy_drivers ?? 0, supporting: "Drivers with active assignments in the verified database state." },
        { label: "Pending Orders", value: data?.summary?.pending_orders ?? 0, supporting: "Orders still awaiting the next verified operational step." },
        { label: "Avg Queue Minutes", value: data?.summary?.avg_queue_minutes ?? 0, supporting: data?.summary?.recommended_action },
      ]}
      highlights={[
        ...(data?.telemetry?.signals ?? []),
        ...(data?.longcat?.rider_guidance ?? []),
        logisticsTower?.summary ?? "Loading logistics control-tower summary…",
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
          items: logisticsTower
            ? [
                logisticsTower.summary ?? "Loading logistics control-tower summary…",
                `Route: /logistics-control-tower · risk band ${logisticsTower.network?.resilience_band ?? "unknown"} · critical nodes ${logisticsTower.network?.critical_nodes ?? 0}`,
              ]
            : [],
        },
      ]}
    />
  );
}
