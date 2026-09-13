import { Suspense, lazy } from "react";
import { useQuery } from "@tanstack/react-query";
import PlatformSummaryPage from "@/components/PlatformSummaryPage";
import type { DurableTrackingPosition } from "@/components/VehicleTrackingMap";
import { useRoleScopedTracking } from "@/lib/useRoleScopedTracking";
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

const VehicleTrackingMap = lazy(
  () => import("@/components/VehicleTrackingMap"),
);

function mapTrackingDeltaToPosition(delta: {
  orderId: number;
  observedAt: string;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  etaSeconds: number | null;
}): DurableTrackingPosition {
  return {
    work_order_id: `delivery-${delta.orderId}`,
    external_reference: `Delivery ${delta.orderId}`,
    subject_user_id: null,
    observed_at: delta.observedAt,
    latitude: delta.latitude,
    longitude: delta.longitude,
    accuracy_m: delta.accuracyM,
    integrity_score: null,
    source: "role_scoped_delivery_delta",
    eta_seconds: delta.etaSeconds,
  };
}

export default function DriverMobility() {
  const query = trpc.driverMobility.summary.useQuery({ limit: 8 });
  const logisticsQuery =
    trpc.localCommerceSuperGateway.logisticsControlTower.useQuery({
      city: "Lagos",
    });
  const tracking = useRoleScopedTracking("me");
  const trackingPositions = tracking.deltas.map(mapTrackingDeltaToPosition);
  const logisticsTower = logisticsQuery.data as
    | LogisticsTowerSummary
    | undefined;
  const data = query.data;

  return (
    <PlatformSummaryPage
      title="Driver Mobility"
      description="Operate a unified supply network where drivers can earn across passenger mobility, courier delivery, airport transfers, healthcare transport, and assisted logistics runs."
      badge="Supply operations"
      icon={CarFront}
      loading={query.isLoading}
      error={query.error?.message}
      monitoringPanel={
        <Suspense
          fallback={
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-6 text-sm text-slate-300">
              Loading the durable vehicle map…
            </div>
          }
        >
          <VehicleTrackingMap
            positions={trackingPositions}
            isLoading={tracking.status === "bootstrapping"}
            error={tracking.error}
            refreshedAt={tracking.updatedAt}
            streamStatus={tracking.status}
            freshness={tracking.freshness}
            truncated={tracking.truncated}
            onPause={tracking.pause}
            onResume={tracking.resume}
          />
        </Suspense>
      }
      metrics={[
        {
          label: "Online Drivers",
          value: data?.summary?.online_drivers ?? 0,
          supporting: "Drivers currently available for multimodal assignments.",
        },
        {
          label: "Busy Drivers",
          value: data?.summary?.busy_drivers ?? 0,
          supporting:
            "Drivers with active assignments in the verified database state.",
        },
        {
          label: "Pending Orders",
          value: data?.summary?.pending_orders ?? 0,
          supporting:
            "Orders still awaiting the next verified operational step.",
        },
        {
          label: "Avg Queue Minutes",
          value: data?.summary?.avg_queue_minutes ?? 0,
          supporting: data?.summary?.recommended_action,
        },
      ]}
      highlights={[
        ...(data?.telemetry?.signals ?? []),
        ...(data?.longcat?.rider_guidance ?? []),
        logisticsTower?.summary ?? "Loading logistics control-tower summary…",
      ]}
      sections={[
        {
          title: "Supply Queue",
          description:
            "Live driver roster with mode, reliability, and earnings context.",
          items: data?.supply_queue ?? [],
        },
        {
          title: "LongCat Dispatch Brief",
          description:
            "Local AI guidance for real-time balancing, batching, and dispatch explainability.",
          items: [
            data?.longcat?.dispatch_brief ?? "Loading dispatch brief…",
            data?.longcat?.batching_strategy ?? "Loading batching strategy…",
          ],
        },
        {
          title: "Dispatch Risk Flags",
          description:
            "Operational risks and guardrails synthesized by the LongCat dispatch layer.",
          items: data?.longcat?.risk_flags ?? [],
        },
        {
          title: "Ranked Candidates",
          description:
            "Driver ranking summary derived from the embedded dispatch optimizer.",
          items: data?.longcat?.ranked_candidates ?? [],
        },
        {
          title: "Logistics Control Tower",
          description:
            "Supply-chain and warehouse resilience context that can change dispatch routing and ETA honesty.",
          items: logisticsTower
            ? [
                logisticsTower.summary ??
                  "Loading logistics control-tower summary…",
                `Route: /logistics-control-tower · risk band ${logisticsTower.network?.resilience_band ?? "unknown"} · critical nodes ${logisticsTower.network?.critical_nodes ?? 0}`,
              ]
            : [],
        },
      ]}
    />
  );
}
