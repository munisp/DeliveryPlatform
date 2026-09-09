import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("vehicle tracker queue-aware autoscaling and 80-session rehearsal contract", () => {
  const metrics = read("server/_core/vehicleTrackerMetrics.ts");
  const worker = read("server/workers/vehicleTrackerIngestWorker.ts");
  const env = read("server/_core/env.ts");
  const trackerWorkload = read("deploy/kubernetes/tracker-ingest/workloads.yaml");
  const rules = read("deploy/kubernetes/monitoring/prometheus-rules.yaml");
  const adapter = read(
    "deploy/kubernetes/tracker-autoscaling/prometheus-adapter/workloads.yaml",
  );
  const keda = read("deploy/kubernetes/tracker-autoscaling/keda/workloads.yaml");
  const surgePatch = read(
    "deploy/kubernetes/tracker-ingest-safe-rollout/rolling-update-max-surge-zero.yaml",
  );
  const rehearsalOverlay = read(
    "deploy/kubernetes/tracker-ingest-rehearsal/kustomization.yaml",
  );
  const runner = read(
    "scripts/testing/run-vehicle-tracker-multipod-rehearsal.sh",
  );
  const headroomGate = read(
    "scripts/testing/check-vehicle-tracker-pgbouncer-headroom.sh",
  );
  const locust = read(
    "scripts/testing/locust/locustfile_vehicle_tracker_rehearsal.py",
  );

  it("emits a bounded provider work-lane signal rather than pretending to know external record depth", () => {
    expect(metrics).toContain("setProviderOverdueCursor");
    expect(metrics).toContain("vehicle_tracker_provider_overdue_cursors");
    expect(metrics).toContain("not a record count");
    expect(metrics).toContain('autoscaling_scope: "vehicle-tracker-ingest"');
    expect(metrics).toContain("namespace: input.namespace");
    expect(worker).toContain("resetProviderOverdueCursors");
    expect(worker).toContain("setProviderOverdueCursor");
    expect(worker).toContain("ENV.vehicleTrackerProviderPollIntervalMs");
    expect(worker).toContain("ENV.vehicleTrackerMetricsNamespace");
    expect(env).toContain("vehicleTrackerMetricsNamespace");
    expect(trackerWorkload).toContain('VEHICLE_TRACKER_METRICS_NAMESPACE: "switchos"');
    expect(rules).toContain("vehicle_tracker_provider_overdue_cursors_by_namespace");
    expect(rules).toContain("max by (namespace, provider_kind, integration_key)");
  });

  it("defines secure, explicitly alternative adapter and KEDA scaling paths", () => {
    expect(adapter).toContain("registry.k8s.io/prometheus-adapter/prometheus-adapter:v0.12.0");
    expect(adapter).toContain("kind: APIService");
    expect(adapter).toContain("cert-manager.io/inject-ca-from");
    expect(adapter).toContain("kind: Certificate");
    expect(adapter).toContain("external.metrics.k8s.io");
    expect(adapter).toContain("vehicle_tracker_provider_overdue_cursors");
    expect(adapter).toContain("averageValue: 250m");
    expect(adapter).toContain("selectPolicy: Min");
    expect(keda).toContain("kind: ScaledObject");
    expect(keda).toContain("scaledobject.keda.sh/transfer-hpa-ownership: \"true\"");
    expect(keda).toContain("authModes: tls,basic");
    expect(keda).toContain('ignoreNullValues: "false"');
    expect(keda).toContain('threshold: "0.25"');
  });

  it("bounds the rollover spike and requires read-only backend headroom before test traffic", () => {
    expect(surgePatch).toContain("maxSurge: 0");
    expect(surgePatch).toContain("maxUnavailable: 1");
    expect(rehearsalOverlay).toContain("namespace: switchos-rehearsal");
    expect(rehearsalOverlay).toContain("VEHICLE_TRACKER_METRICS_NAMESPACE");
    expect(headroomGate).toContain("ALLOW_NON_PRODUCTION_TRACKER_REHEARSAL");
    expect(headroomGate).toContain("context_must_be_explicitly_non_production");
    expect(headroomGate).toContain("TRACKER_MAX_BACKEND_CONNECTIONS:-48");
    expect(headroomGate).toContain("TRACKER_MAX_WORKER_CLIENT_CONNECTIONS:-256");
    expect(headroomGate).toContain("max_surge_zero_overlay_not_observed");
    expect(headroomGate).toContain("tracker_worker_count_outside_16_to_64_envelope");
    expect(headroomGate).toContain("TRACKER_EXPECTED_POOLERS:-4");
    expect(headroomGate).toContain("unexpected_ready_pooler_count");
    expect(headroomGate).toContain("pgbouncer_pools_client_waiting_connections");
  });

  it("runs only explicit test stages and sends real signed ingress events with durable accounting", () => {
    expect(runner).toContain('TRACKER_REHEARSAL_STAGES:-16 32 48 64');
    expect(runner).toContain('TRACKER_TOTAL_BACKEND_BUDGET:-80');
    expect(runner).toContain("TRACKER_REHEARSAL_INGRESS_URL_must_be_a_local_port_forward");
    expect(runner).toContain("database_url_looks_production");
    expect(runner).toContain("durable_event_mismatch");
    expect(runner).toContain("vehicle_tracker_pgbouncer_server_connections");
    expect(locust).toContain("hmac.new");
    expect(locust).toContain('"x-vehicle-tracker-signature"');
    expect(locust).toContain("POST /api/vehicle-trackers/events/:integrationKey");
    expect(locust).toContain("expected HTTP 202");
  });
});
