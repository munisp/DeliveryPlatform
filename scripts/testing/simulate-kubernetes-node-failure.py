#!/usr/bin/env python3
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
K8S_ROOT = ROOT / "deploy" / "kubernetes"
PACKAGES = ("pricing-dispatch", "central", "go-services", "python-services")
NODES = ("node-a", "node-b", "node-c")
SIMULATED_CPU_UTILIZATION_PERCENT = 150


def load_resources() -> list[dict[str, Any]]:
    resources: list[dict[str, Any]] = []
    for package in PACKAGES:
        for path in sorted((K8S_ROOT / package).glob("*.yaml")):
            for document in yaml.safe_load_all(path.read_text(encoding="utf-8")):
                if isinstance(document, dict):
                    resources.append(document)
    return resources


def placement(deployment: dict[str, Any]) -> list[str]:
    replicas = deployment["spec"]["replicas"]
    name = deployment["metadata"]["name"]
    if name == "central-app":
        return [NODES[index % len(NODES)] for index in range(replicas)]
    return [NODES[index % 2] for index in range(replicas)]


def main() -> None:
    resources = load_resources()
    deployments = {item["metadata"]["name"]: item for item in resources if item.get("kind") == "Deployment"}
    hpas = {item["metadata"]["name"]: item for item in resources if item.get("kind") == "HorizontalPodAutoscaler"}
    pdbs = {item["metadata"]["name"]: item for item in resources if item.get("kind") == "PodDisruptionBudget"}
    if len(deployments) != 14 or set(deployments) != set(hpas) or set(deployments) != set(pdbs):
        raise SystemExit("manifest inventory is incomplete; run the Kubernetes validator first")

    results: list[dict[str, Any]] = []
    for failed_node in NODES:
        for name in sorted(deployments):
            deployment = deployments[name]
            desired = deployment["spec"]["replicas"]
            hpa_minimum = hpas[name]["spec"]["minReplicas"]
            pdb_minimum = pdbs[name]["spec"]["minAvailable"]
            initial = placement(deployment)
            surviving = [node for node in initial if node != failed_node]
            initial_available = len(surviving)
            voluntary_eviction_allowed_before_failure = desired - 1 >= pdb_minimum
            voluntary_eviction_allowed_after_failure = initial_available - 1 >= pdb_minimum
            cpu_target = hpas[name]["spec"]["metrics"][0]["resource"]["target"]["averageUtilization"]
            pressure_scale_target = math.ceil(desired * SIMULATED_CPU_UTILIZATION_PERCENT / cpu_target)
            hpa_scale_target = min(hpas[name]["spec"]["maxReplicas"], max(hpa_minimum, pressure_scale_target))
            recovery_target = max(desired, hpa_minimum, hpa_scale_target)
            replacement_count = recovery_target - initial_available
            healthy_nodes = [node for node in NODES if node != failed_node]
            hard_spread = name != "central-app"
            # Strict maxSkew=1 spreading still permits multiple pods per healthy
            # node, provided the desired replica count can be balanced across
            # both remaining domains. Resource capacity is a separate cluster
            # prerequisite and is intentionally not fabricated by this model.
            if hard_spread:
                schedulable = len(healthy_nodes) >= 2 and recovery_target >= 2
            else:
                schedulable = len(healthy_nodes) >= 1
            recovered_available = initial_available + replacement_count if schedulable else initial_available
            results.append(
                {
                    "failed_node": failed_node,
                    "deployment": name,
                    "desired_replicas": desired,
                    "hpa_min_replicas": hpa_minimum,
                    "pdb_min_available": pdb_minimum,
                    "initial_placement": initial,
                    "available_immediately_after_failure": initial_available,
                    "pdb_satisfied_after_failure": initial_available >= pdb_minimum,
                    "one_voluntary_eviction_allowed_before_failure": voluntary_eviction_allowed_before_failure,
                    "additional_voluntary_eviction_allowed_after_failure": voluntary_eviction_allowed_after_failure,
                    "simulated_cpu_utilization_percent": SIMULATED_CPU_UTILIZATION_PERCENT,
                    "hpa_cpu_target_percent": cpu_target,
                    "hpa_scale_target_under_cpu_pressure": hpa_scale_target,
                    "replacement_pods_required": replacement_count,
                    "recovery_schedulable_on_healthy_nodes": schedulable,
                    "available_after_reconciliation": recovered_available,
                    "hpa_minimum_satisfied_after_reconciliation": recovered_available >= hpa_minimum,
                }
            )

    failures = [
        result
        for result in results
        if not result["pdb_satisfied_after_failure"]
        or (
            result["available_immediately_after_failure"] < result["desired_replicas"]
            and result["additional_voluntary_eviction_allowed_after_failure"]
        )
        or not result["recovery_schedulable_on_healthy_nodes"]
        or result["hpa_scale_target_under_cpu_pressure"] < result["hpa_min_replicas"]
        or not result["hpa_minimum_satisfied_after_reconciliation"]
    ]
    payload = {
        "simulation": "manifest-derived logical node-failure simulation",
        "nodes": list(NODES),
        "failed_node_scenarios": list(NODES),
        "simulated_cpu_utilization_percent": SIMULATED_CPU_UTILIZATION_PERCENT,
        "deployments_tested": len(deployments),
        "scenarios_tested": len(results),
        "failures": failures,
        "results": results,
    }
    output = ROOT / "validation" / "kubernetes_hpa_pdb_node_failure_simulation_20260903.json"
    output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    if failures:
        raise SystemExit(f"node-failure simulation found {len(failures)} invariant failures; see {output}")
    print(f"node-failure simulation passed: {len(results)} manifest-derived scenarios; results={output}")


if __name__ == "__main__":
    main()
