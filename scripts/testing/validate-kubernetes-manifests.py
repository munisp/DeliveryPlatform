#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2] / "deploy" / "kubernetes"
PACKAGES = ("security", "pricing-dispatch", "central", "go-services", "python-services")


def documents(path: Path) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for index, document in enumerate(yaml.safe_load_all(path.read_text(encoding="utf-8")), start=1):
        if not isinstance(document, dict):
            raise SystemExit(f"{path}:{index}: expected a YAML mapping")
        for field in ("apiVersion", "kind"):
            if not document.get(field):
                raise SystemExit(f"{path}:{index}: missing {field}")
        if document["kind"] != "Kustomization":
            metadata = document.get("metadata")
            if not isinstance(metadata, dict) or not metadata.get("name"):
                raise SystemExit(f"{path}:{index}: workload resource requires metadata.name")
        result.append(document)
    return result


def as_int(value: Any, name: str) -> int:
    if not isinstance(value, int):
        raise SystemExit(f"{name} must be an integer")
    return value


files = [ROOT / "kustomization.yaml"] + sorted(path for package in PACKAGES for path in (ROOT / package).glob("*.yaml"))
resources: list[dict[str, Any]] = []
for path in files:
    resources.extend(documents(path))

deployments = {
    resource["metadata"]["name"]: resource
    for resource in resources
    if resource["kind"] == "Deployment"
}
hpas = [resource for resource in resources if resource["kind"] == "HorizontalPodAutoscaler"]
pdbs = [resource for resource in resources if resource["kind"] == "PodDisruptionBudget"]

# The expected Deployment count is derived from the manifests themselves;
# never hardcode it here, it drifts every time a workload is added. The real
# invariant is that every Deployment pairs with exactly one HPA and one PDB.
if not deployments:
    raise SystemExit("no application Deployments found in the scanned packages")
if len(hpas) != len(deployments) or len(pdbs) != len(deployments):
    raise SystemExit("every application Deployment must have exactly one HPA and one PDB")

for name, deployment in deployments.items():
    spec = deployment.get("spec", {})
    replicas = as_int(spec.get("replicas"), f"Deployment/{name}.spec.replicas")
    if replicas < 2:
        raise SystemExit(f"Deployment/{name} must have at least two replicas for node-failure resilience")
    pod_spec = spec.get("template", {}).get("spec", {})
    constraints = pod_spec.get("topologySpreadConstraints", [])
    if name != "central-app" and not constraints:
        raise SystemExit(f"Deployment/{name} must define topology spread constraints")
    containers = pod_spec.get("containers", [])
    if len(containers) != 1:
        raise SystemExit(f"Deployment/{name} must define exactly one application container")
    container = containers[0]
    for probe in ("startupProbe", "readinessProbe", "livenessProbe"):
        if "httpGet" not in container.get(probe, {}):
            raise SystemExit(f"Deployment/{name} lacks an HTTP {probe}")
    security = container.get("securityContext", {})
    if security.get("allowPrivilegeEscalation") is not False or security.get("readOnlyRootFilesystem") is not True:
        raise SystemExit(f"Deployment/{name} container security context is incomplete")

for hpa in hpas:
    name = hpa["metadata"]["name"]
    spec = hpa.get("spec", {})
    target = spec.get("scaleTargetRef", {}).get("name")
    if target not in deployments or target != name:
        raise SystemExit(f"HPA/{name} must target Deployment/{name}")
    minimum = as_int(spec.get("minReplicas"), f"HPA/{name}.spec.minReplicas")
    maximum = as_int(spec.get("maxReplicas"), f"HPA/{name}.spec.maxReplicas")
    if minimum < 2 or maximum < minimum:
        raise SystemExit(f"HPA/{name} has an invalid resilient replica range")

for pdb in pdbs:
    name = pdb["metadata"]["name"]
    if name not in deployments:
        raise SystemExit(f"PDB/{name} has no Deployment")
    min_available = as_int(pdb.get("spec", {}).get("minAvailable"), f"PDB/{name}.spec.minAvailable")
    replicas = deployments[name]["spec"]["replicas"]
    if min_available < 1 or min_available >= replicas:
        raise SystemExit(f"PDB/{name} must preserve one or more pods while allowing one voluntary disruption")

print(f"validated {len(files)} Kubernetes manifest files, {len(deployments)} Deployments, {len(hpas)} HPAs, and {len(pdbs)} PDBs")
