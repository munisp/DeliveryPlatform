#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
NAMESPACE = "switchos"
IMAGE_PREFIX = "ghcr.io/munisp/deliveryplatform"

GO_SERVICES = [
    ("inventory-control", 8117, "PORT", True, "250m", "256Mi", "1", "512Mi"),
    ("local-commerce-gateway", 8114, "PORT", True, "250m", "256Mi", "1", "512Mi"),
    ("mojaloop", 8086, "HTTP_PORT", True, "500m", "512Mi", "2", "1Gi"),
    ("notification-dispatcher", 8099, "PORT", False, "250m", "256Mi", "1", "512Mi"),
    ("vertical-provisioning", 8112, "PORT", False, "250m", "256Mi", "1", "512Mi"),
    ("voice-gateway", 8104, "PORT", False, "500m", "512Mi", "2", "1Gi"),
    ("ride-matching-worker", 8121, "PORT", False, "500m", "512Mi", "2", "1Gi"),
]

PYTHON_SERVICES = [
    ("intake-orchestrator", 8113, "250m", "256Mi", "1", "512Mi"),
    ("lakehouse", 8007, "250m", "256Mi", "1", "512Mi"),
    ("procurement-planner", 8116, "250m", "256Mi", "1", "512Mi"),
    ("retail-forecast", 8115, "250m", "256Mi", "1", "512Mi"),
    ("speech-runtime", 8105, "500m", "512Mi", "2", "1Gi"),
    ("ride-payment-webhook", 8122, "250m", "256Mi", "1", "512Mi"),
    ("compliance-review", 8125, "250m", "256Mi", "1", "512Mi"),
]


def labels(name: str, component: str) -> dict[str, str]:
    return {
        "app.kubernetes.io/name": name,
        "app.kubernetes.io/component": component,
        "app.kubernetes.io/part-of": "deliveryplatform",
    }


def probes() -> dict[str, Any]:
    return {
        "startupProbe": {"httpGet": {"path": "/health", "port": "http"}, "failureThreshold": 36, "periodSeconds": 5},
        "readinessProbe": {"httpGet": {"path": "/health", "port": "http"}, "periodSeconds": 10, "timeoutSeconds": 3, "failureThreshold": 3},
        "livenessProbe": {"httpGet": {"path": "/health", "port": "http"}, "initialDelaySeconds": 20, "periodSeconds": 20, "timeoutSeconds": 3, "failureThreshold": 3},
    }


def workload(name: str, component: str, port: int, config: str, secret: str, request_cpu: str, request_memory: str, limit_cpu: str, limit_memory: str, port_env: str, dapr: bool = False, speech: bool = False) -> list[dict[str, Any]]:
    app_labels = labels(name, component)
    annotations: dict[str, str] = {}
    if dapr:
        annotations = {
            "dapr.io/enabled": "true",
            "dapr.io/app-id": name,
            "dapr.io/app-port": str(port),
            "dapr.io/config": "switchos-dapr-config",
        }
    container: dict[str, Any] = {
        "name": name,
        "image": f"{IMAGE_PREFIX}-{name}:REPLACE_WITH_IMMUTABLE_TAG",
        "imagePullPolicy": "IfNotPresent",
        "ports": [{"name": "http", "containerPort": port}],
        "envFrom": [{"configMapRef": {"name": config}}, {"secretRef": {"name": secret}}],
        "env": [{"name": port_env, "value": str(port)}],
        "resources": {
            "requests": {"cpu": request_cpu, "memory": request_memory},
            "limits": {"cpu": limit_cpu, "memory": limit_memory},
        },
        "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}},
    }
    container.update(probes())
    pod_spec: dict[str, Any] = {
        "serviceAccountName": "go-services" if component == "go-service" else "python-services",
        "automountServiceAccountToken": False,
        "securityContext": {"runAsNonRoot": True, "runAsUser": 10001, "runAsGroup": 10001, "fsGroup": 10001, "seccompProfile": {"type": "RuntimeDefault"}},
        "topologySpreadConstraints": [{"maxSkew": 1, "minDomains": 2, "topologyKey": "kubernetes.io/hostname", "whenUnsatisfiable": "DoNotSchedule", "labelSelector": {"matchLabels": {"app.kubernetes.io/name": name}}}],
        "containers": [container],
    }
    if speech:
        container["env"].extend([
            {"name": "PIPER_BIN", "value": "/opt/speech-models/piper"},
            {"name": "PIPER_MODEL", "value": "/opt/speech-models/en_US-lessac-medium.onnx"},
            {"name": "LONGCAT_SPEECH_STT_MODEL", "value": "/opt/speech-models/whisper"},
        ])
        container["volumeMounts"] = [{"name": "speech-models", "mountPath": "/opt/speech-models", "readOnly": True}]
        pod_spec["volumes"] = [{"name": "speech-models", "persistentVolumeClaim": {"claimName": "speech-runtime-models"}}]
    deployment = {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {"name": name, "namespace": NAMESPACE, "labels": app_labels},
        "spec": {
            "replicas": 2,
            "revisionHistoryLimit": 3,
            "selector": {"matchLabels": {"app.kubernetes.io/name": name}},
            "template": {"metadata": {"labels": app_labels, "annotations": annotations}, "spec": pod_spec},
        },
    }
    service = {"apiVersion": "v1", "kind": "Service", "metadata": {"name": name, "namespace": NAMESPACE, "labels": app_labels}, "spec": {"selector": {"app.kubernetes.io/name": name}, "ports": [{"name": "http", "port": port, "targetPort": "http"}]}}
    pdb = {"apiVersion": "policy/v1", "kind": "PodDisruptionBudget", "metadata": {"name": name, "namespace": NAMESPACE, "labels": app_labels}, "spec": {"minAvailable": 1, "selector": {"matchLabels": {"app.kubernetes.io/name": name}}}}
    hpa = {"apiVersion": "autoscaling/v2", "kind": "HorizontalPodAutoscaler", "metadata": {"name": name, "namespace": NAMESPACE, "labels": app_labels}, "spec": {"scaleTargetRef": {"apiVersion": "apps/v1", "kind": "Deployment", "name": name}, "minReplicas": 2, "maxReplicas": 5, "behavior": {"scaleDown": {"stabilizationWindowSeconds": 300}}, "metrics": [{"type": "Resource", "resource": {"name": "cpu", "target": {"type": "Utilization", "averageUtilization": 70}}}]}}
    return [deployment, service, pdb, hpa]


def peer(labels: dict[str, str]) -> dict[str, Any]:
    return {
        "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": NAMESPACE}},
        "podSelector": {"matchLabels": labels},
    }


def policy(component: str) -> dict[str, Any]:
    if component == "go-service":
        ingress_sources = [peer({"app.kubernetes.io/name": "central-app"}), peer({"app.kubernetes.io/component": "go-service"})]
        ingress_ports = [8086, 8099, 8104, 8112, 8114, 8117, 8121]
        internal_egress_ports = [3000, 3005, 4001, 5432, 6379, 7233, 8007, 8090, 8105, 9092, 8112, 8113, 8114, 8115, 8116, 8117, 8121, 8122]
    else:
        ingress_sources = [peer({"app.kubernetes.io/name": "central-app"}), peer({"app.kubernetes.io/component": "go-service"})]
        ingress_ports = [8007, 8105, 8113, 8115, 8116, 8122, 8125]
        internal_egress_ports = [5432, 8121, 8125]
    return {
        "apiVersion": "networking.k8s.io/v1",
        "kind": "NetworkPolicy",
        "metadata": {"name": f"{component}-restrict-traffic", "namespace": NAMESPACE},
        "spec": {
            "podSelector": {"matchLabels": {"app.kubernetes.io/component": component}},
            "policyTypes": ["Ingress", "Egress"],
            "ingress": [{"from": ingress_sources, "ports": [{"protocol": "TCP", "port": port} for port in ingress_ports]}],
            "egress": [
                {"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": NAMESPACE}}}], "ports": [{"protocol": "TCP", "port": port} for port in internal_egress_ports]},
                {"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}}}], "ports": [{"protocol": "UDP", "port": 53}, {"protocol": "TCP", "port": 53}]},
                {"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "dapr-system"}}}], "ports": [{"protocol": "TCP", "port": 443}, {"protocol": "TCP", "port": 50001}, {"protocol": "TCP", "port": 50005}]},
                {"to": [{"ipBlock": {"cidr": "0.0.0.0/0"}}], "ports": [{"protocol": "TCP", "port": 443}]},
            ],
        },
    }


def payment_webhook_ingress_policy() -> dict[str, Any]:
    return {
        "apiVersion": "networking.k8s.io/v1",
        "kind": "NetworkPolicy",
        "metadata": {"name": "ride-payment-webhook-ingress", "namespace": NAMESPACE},
        "spec": {
            "podSelector": {"matchLabels": {"app.kubernetes.io/name": "ride-payment-webhook"}},
            "policyTypes": ["Ingress"],
            "ingress": [{
                "from": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "ingress-nginx"}}}],
                "ports": [{"protocol": "TCP", "port": 8122}],
            }],
        },
    }


def dump(path: Path, documents: list[dict[str, Any]]) -> None:
    path.write_text(yaml.safe_dump_all(documents, sort_keys=False), encoding="utf-8")


def main() -> None:
    go_docs: list[dict[str, Any]] = []
    for name, port, port_env, dapr, req_cpu, req_mem, lim_cpu, lim_mem in GO_SERVICES:
        go_docs.extend(workload(name, "go-service", port, "go-services-runtime-config", "go-services-secrets", req_cpu, req_mem, lim_cpu, lim_mem, port_env, dapr=dapr))
    go_docs.append(policy("go-service"))
    dump(ROOT / "deploy/kubernetes/go-services/workloads.yaml", go_docs)

    python_docs: list[dict[str, Any]] = []
    for name, port, req_cpu, req_mem, lim_cpu, lim_mem in PYTHON_SERVICES:
        python_docs.extend(workload(name, "python-service", port, "python-services-runtime-config", "python-services-secrets", req_cpu, req_mem, lim_cpu, lim_mem, "PORT", speech=name == "speech-runtime"))
    python_docs.append(policy("python-service"))
    python_docs.append(payment_webhook_ingress_policy())
    dump(ROOT / "deploy/kubernetes/python-services/workloads.yaml", python_docs)


if __name__ == "__main__":
    main()
