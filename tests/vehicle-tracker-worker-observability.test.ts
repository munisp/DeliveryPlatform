import { describe, expect, it } from "vitest";

import { vehicleTrackerMetrics } from "../server/_core/vehicleTrackerMetrics";

describe("vehicle tracker Prometheus metrics", () => {
  it("renders bounded lease, pool, query, and lock-wait metric families", () => {
    vehicleTrackerMetrics.setPool(4, 1, 2, 4);
    vehicleTrackerMetrics.setDatabaseLockState({
      activeTransactions: 3,
      lockWaitingTransactions: 1,
      maxLockWaitSeconds: 5.5,
      available: true,
    });
    vehicleTrackerMetrics.setLeaseState({
      providerKind: "geotab_feed",
      integrationKey: "fleet.geotab.primary",
      leaseExpiresAtSeconds: 1_800_000_000,
      cursorAgeSeconds: 30,
      lastErrorAgeSeconds: null,
    });
    vehicleTrackerMetrics.observeDatabaseQuery("bulk_record", 0.123);
    vehicleTrackerMetrics.observeFence("geotab_feed", "complete");

    const exposition = vehicleTrackerMetrics.render();
    expect(exposition).toContain(
      'vehicle_tracker_pool_connections{state="waiting"} 2',
    );
    expect(exposition).toContain("vehicle_tracker_pool_max_connections 4");
    expect(exposition).toContain(
      "vehicle_tracker_database_lock_observability_up 1",
    );
    expect(exposition).toContain(
      "vehicle_tracker_database_lock_waiting_transactions 1",
    );
    expect(exposition).toContain(
      'vehicle_tracker_provider_cursor_lease_expires_at_seconds{integration_key="fleet.geotab.primary",provider_kind="geotab_feed"} 1800000000',
    );
    expect(exposition).toContain(
      'vehicle_tracker_database_query_duration_seconds_count{operation="bulk_record"} 1',
    );
    expect(exposition).toContain(
      'vehicle_tracker_provider_cursor_fence_failures_total{operation="complete",provider_kind="geotab_feed"} 1',
    );
  });

  it("emits a bounded overdue-provider work-lane gauge for safe autoscaling", () => {
    vehicleTrackerMetrics.setProviderOverdueCursor({
      providerKind: "geotab_feed",
      integrationKey: "fleet.geotab.autoscaling",
      cursorAgeSeconds: 119,
      pollIntervalMs: 60_000,
      namespace: "switchos-rehearsal",
    });
    vehicleTrackerMetrics.setProviderOverdueCursor({
      providerKind: "traccar_rest",
      integrationKey: "fleet.traccar.autoscaling",
      cursorAgeSeconds: 120,
      pollIntervalMs: 60_000,
      namespace: "switchos-rehearsal",
    });

    const exposition = vehicleTrackerMetrics.render();
    expect(exposition).toContain(
      'vehicle_tracker_provider_overdue_cursors{autoscaling_scope="vehicle-tracker-ingest",integration_key="fleet.geotab.autoscaling",namespace="switchos-rehearsal",provider_kind="geotab_feed"} 0',
    );
    expect(exposition).toContain(
      'vehicle_tracker_provider_overdue_cursors{autoscaling_scope="vehicle-tracker-ingest",integration_key="fleet.traccar.autoscaling",namespace="switchos-rehearsal",provider_kind="traccar_rest"} 1',
    );
  });

  it("does not publish arbitrary provider kinds or unbounded integration labels", () => {
    vehicleTrackerMetrics.setLeaseState({
      providerKind: "untrusted_provider_kind",
      integrationKey:
        "INVALID/EXTERNAL/IDENTIFIER/THAT/SHOULD/NOT/BECOME/A/LABEL",
      leaseExpiresAtSeconds: 0,
      cursorAgeSeconds: 0,
      lastErrorAgeSeconds: null,
    });

    const exposition = vehicleTrackerMetrics.render();
    expect(exposition).toContain('provider_kind="other"');
    expect(exposition).not.toContain("INVALID/EXTERNAL/IDENTIFIER");
  });
});
