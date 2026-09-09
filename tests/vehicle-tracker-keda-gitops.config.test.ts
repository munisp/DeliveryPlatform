import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");

describe("vehicle tracker KEDA and Argo CD GitOps contract", () => {
  const terraform = read("deploy/terraform/keda-argocd-bootstrap/main.tf");
  const variables = read("deploy/terraform/keda-argocd-bootstrap/variables.tf");
  const applications = read("deploy/kubernetes/argocd/vehicle-tracker-autoscaling/applications.yaml");
  const foundation = read("deploy/kubernetes/tracker-ingest-keda-foundation/kustomization.yaml");
  const productionKustomization = read("deploy/kubernetes/tracker-autoscaling/keda-production/kustomization.yaml");
  const gateManifest = read("deploy/kubernetes/tracker-autoscaling/keda-production/pre-rollout-gate.yaml");
  const gateSource = read("deploy/kubernetes/tracker-autoscaling/keda-production/rollout-gate/main.go");

  it("installs a pinned KEDA controller separately from workload GitOps", () => {
    expect(terraform).toContain('chart            = "keda"');
    expect(terraform).toContain('version          = var.keda_chart_version');
    expect(terraform).toContain("atomic           = true");
    expect(terraform).toContain("cleanup_on_fail  = true");
    expect(terraform).toContain("timeout          = 600");
    expect(variables).toContain('default     = "2.20.2"');
    expect(variables).toContain('cidr != "0.0.0.0/0"');
    expect(variables).toContain('cidr != "::/0"');
    expect(terraform).toContain('port     = "9090"');
    expect(terraform).toContain('port     = "443"');
  });

  it("prevents concurrent native-HPA and KEDA ownership", () => {
    expect(foundation).toContain("$patch: delete");
    expect(foundation).toContain("kind: HorizontalPodAutoscaler");
    expect(productionKustomization).toContain("- ../keda");
    expect(productionKustomization).not.toContain("../../tracker-ingest-safe-rollout");
    expect(applications).toContain("vehicle-tracker-rollout-foundation");
    expect(applications).toContain("path: deploy/kubernetes/tracker-ingest-keda-foundation");
    expect(applications).toContain("path: deploy/kubernetes/tracker-autoscaling/keda-production");
    expect(applications).toContain("- group: keda.sh");
    expect(applications).toContain("FailOnSharedResource=true");
  });

  it("runs a least-privilege fail-closed PreSync gate before autoscaling reconciliation", () => {
    expect(gateManifest).toContain("argocd.argoproj.io/hook: PreSync");
    expect(gateManifest).toContain('argocd.argoproj.io/sync-wave: "-10"');
    expect(gateManifest).toContain("backoffLimit: 0");
    expect(gateManifest).toContain("activeDeadlineSeconds: 90");
    expect(gateManifest).toContain("resourceNames: [\"vehicle-tracker-ingest\", \"vehicle-tracker-pgbouncer\"]");
    expect(gateManifest).toContain("readOnlyRootFilesystem: true");
    expect(gateManifest).toContain("allowPrivilegeEscalation: false");
    expect(gateManifest).toContain("MAX_BACKEND_CONNECTIONS");
    expect(gateManifest).toContain('value: "48"');
    expect(gateManifest).toContain('value: "256"');
    expect(gateSource).toContain("max_surge_zero_overlay_not_observed");
    expect(gateSource).toContain("worker_client_ceiling");
    expect(gateSource).toContain("Prometheus query must return exactly one instant-vector sample");
    expect(gateSource).not.toContain("InsecureSkipVerify");
  });
});
