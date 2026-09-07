#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2] / "deploy" / "kubernetes"
PACKAGES = ("security", "pricing-dispatch", "central", "go-services", "python-services")
EXPECTED_RUNTIME_SAS = {
    "central-app": "central-app",
    "pricing-engine": "pricing-dispatch",
    "dispatch-optimizer": "pricing-dispatch",
    "inventory-control": "go-services",
    "local-commerce-gateway": "go-services",
    "mojaloop": "go-services",
    "notification-dispatcher": "go-services",
    "vertical-provisioning": "go-services",
    "voice-gateway": "go-services",
    "ride-matching-worker": "go-services",
    "intake-orchestrator": "python-services",
    "lakehouse": "python-services",
    "procurement-planner": "python-services",
    "retail-forecast": "python-services",
    "speech-runtime": "python-services",
    "ride-payment-webhook": "python-services",
    "compliance-review": "python-services",
}
EXPECTED_EXTERNAL_SECRETS = {
    "switchos-runtime-secrets",
    "central-app-secrets",
    "go-services-secrets",
    "python-services-secrets",
}


def load_yaml(path: Path) -> list[dict[str, Any]]:
    documents: list[dict[str, Any]] = []
    for index, document in enumerate(yaml.safe_load_all(path.read_text(encoding="utf-8")), start=1):
        if not isinstance(document, dict):
            raise SystemExit(f"{path}:{index}: expected YAML mapping")
        documents.append(document)
    return documents


resources: list[tuple[Path, dict[str, Any]]] = []
for package in PACKAGES:
    for path in sorted((ROOT / package).glob("*.yaml")):
        resources.extend((path, document) for document in load_yaml(path))

failures: list[str] = []
by_kind: dict[str, list[dict[str, Any]]] = {}
for _, resource in resources:
    by_kind.setdefault(str(resource.get("kind")), []).append(resource)

namespaces = by_kind.get("Namespace", [])
if len(namespaces) != 1:
    failures.append("expected one switchos Namespace resource")
else:
    labels = namespaces[0].get("metadata", {}).get("labels", {})
    if labels.get("pod-security.kubernetes.io/enforce") != "restricted":
        failures.append("switchos namespace must enforce restricted Pod Security Admission")

for deployment in by_kind.get("Deployment", []):
    name = deployment["metadata"]["name"]
    spec = deployment["spec"]["template"]["spec"]
    if spec.get("serviceAccountName") != EXPECTED_RUNTIME_SAS.get(name):
        failures.append(f"Deployment/{name} lacks its expected dedicated service account")
    if spec.get("automountServiceAccountToken") is not False:
        failures.append(f"Deployment/{name} must disable service-account token automounting")
    security = spec.get("securityContext", {})
    if not security.get("runAsNonRoot") or security.get("seccompProfile", {}).get("type") != "RuntimeDefault":
        failures.append(f"Deployment/{name} has incomplete pod security context")
    for container in spec.get("containers", []):
        container_security = container.get("securityContext", {})
        if container_security.get("allowPrivilegeEscalation") is not False or container_security.get("readOnlyRootFilesystem") is not True:
            failures.append(f"Deployment/{name} has incomplete container hardening")

for job in by_kind.get("Job", []):
    spec = job["spec"]["template"]["spec"]
    if spec.get("serviceAccountName") != "schema-migrator" or spec.get("automountServiceAccountToken") is not False:
        failures.append("schema migration Job must use schema-migrator without a token")

if by_kind.get("ClusterRole") or by_kind.get("ClusterRoleBinding"):
    failures.append("application package must not grant cluster-wide RBAC")
roles = by_kind.get("Role", [])
if len(roles) != 1 or roles[0]["metadata"]["name"] != "ci-deployer":
    failures.append("expected one namespace-scoped ci-deployer Role")
else:
    for rule in roles[0].get("rules", []):
        resources_in_rule = rule.get("resources", [])
        verbs = rule.get("verbs", [])
        if "*" in resources_in_rule or "*" in verbs or "secrets" in resources_in_rule:
            failures.append("ci-deployer Role must not have wildcard or Secret permissions")

network_policies = by_kind.get("NetworkPolicy", [])
if not any(policy.get("metadata", {}).get("name") == "default-deny-ingress-egress" and policy.get("spec", {}).get("podSelector") == {} for policy in network_policies):
    failures.append("default-deny ingress/egress policy is missing")
for component in ("go-service", "python-service"):
    policy = next((item for item in network_policies if item.get("metadata", {}).get("name") == f"{component}-restrict-traffic"), None)
    if policy is None or set(policy.get("spec", {}).get("policyTypes", [])) != {"Ingress", "Egress"}:
        failures.append(f"{component} restrictive ingress/egress policy is missing")
for policy in network_policies:
    if policy.get("metadata", {}).get("name") in {"go-service-restrict-traffic", "python-service-restrict-traffic", "pricing-dispatch-restrict-ingress", "central-app-restrict-ingress"}:
        for ingress in policy.get("spec", {}).get("ingress", []):
            for peer in ingress.get("from", []):
                if "namespaceSelector" in peer and "podSelector" not in peer and peer["namespaceSelector"].get("matchLabels", {}).get("kubernetes.io/metadata.name") == "switchos":
                    failures.append(f"NetworkPolicy/{policy['metadata']['name']} permits broad switchos namespace ingress")

external_secrets = by_kind.get("ExternalSecret", [])
if {item["metadata"]["name"] for item in external_secrets} != EXPECTED_EXTERNAL_SECRETS:
    failures.append("ExternalSecret inventory does not match runtime secret sets")
for external_secret in external_secrets:
    spec = external_secret.get("spec", {})
    if spec.get("secretStoreRef", {}).get("kind") != "ClusterSecretStore" or spec.get("secretStoreRef", {}).get("name") != "deliveryplatform-secrets":
        failures.append(f"ExternalSecret/{external_secret['metadata']['name']} lacks approved ClusterSecretStore")
    if spec.get("target", {}).get("creationPolicy") != "Owner":
        failures.append(f"ExternalSecret/{external_secret['metadata']['name']} must own its target Secret")

for package in PACKAGES:
    kustomization = ROOT / package / "kustomization.yaml"
    if not kustomization.exists():
        continue
    rendered = kustomization.read_text(encoding="utf-8")
    if "template" in rendered:
        failures.append(f"{kustomization} must not include secret templates")

if failures:
    raise SystemExit("Kubernetes security validation failed:\n- " + "\n- ".join(failures))

print(
    "Kubernetes security validation passed: "
    f"{len(EXPECTED_RUNTIME_SAS)} runtime identities, "
    f"{len(network_policies)} NetworkPolicies, {len(external_secrets)} ExternalSecrets, and namespace-scoped CI RBAC"
)
