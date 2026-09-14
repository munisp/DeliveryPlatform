#!/usr/bin/env python3
"""Static configuration contract check.

Cross-checks every in-scope Kubernetes Deployment's environment wiring
(inline `env` entries plus keys contributed by `envFrom` ConfigMaps and
Secret templates) against the environment variables the service code
actually reads and the variables the code declares as REQUIRED for boot:

* required-but-not-in-manifest: a variable in the service's boot-time
  required table (requiredEnvironmentVariables / REQUIRED_ENV_VARS) is not
  provided by the Deployment's inline env, referenced ConfigMaps, or
  referenced Secret templates. Deployments that mount a Secret with no
  in-repo template are treated as wildcard providers (the secret manager
  owns the contents) and cannot fail this check.
* manifest-but-never-read: an inline `env` entry, ConfigMap key, or Secret
  template key is never read by any service that consumes it.

Exit code is non-zero when any drift is found.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
KUBERNETES_ROOT = ROOT / "deploy" / "kubernetes"

# Deployment (manifest file, deployment name) -> (service source dir, language).
# Services without an in-cluster Deployment (verification-orchestrator,
# verification-policy, verification-intelligence) are validated by their
# boot-time checks only and are intentionally absent here.
DEPLOYMENT_SERVICES: list[tuple[str, str, str, str]] = [
    ("go-services/workloads.yaml", "inventory-control", "services/go/inventory-control", "go"),
    ("go-services/workloads.yaml", "local-commerce-gateway", "services/go/local-commerce-gateway", "go"),
    ("go-services/workloads.yaml", "mojaloop", "services/go/mojaloop", "go"),
    ("go-services/workloads.yaml", "notification-dispatcher", "services/go/notification-dispatcher", "go"),
    ("go-services/workloads.yaml", "vertical-provisioning", "services/go/vertical-provisioning", "go"),
    ("go-services/workloads.yaml", "voice-gateway", "services/go/voice-gateway", "go"),
    ("go-services/workloads.yaml", "ride-matching-worker", "services/go/ride-matching-worker", "go"),
    ("outbox-autoscaling/financial-outbox-worker.yaml", "mojaloop-funds-outbox", "services/go/mojaloop", "go"),
    ("resilience-test/circuit-breaker-alert-receiver.yaml", "resilience-circuit-breaker-alert-receiver", "services/go/resilience-circuit-breaker-alert-receiver", "go"),
    ("python-services/workloads.yaml", "intake-orchestrator", "services/python/intake-orchestrator", "python"),
    ("python-services/workloads.yaml", "lakehouse", "services/python/lakehouse", "python"),
    ("python-services/workloads.yaml", "procurement-planner", "services/python/procurement-planner", "python"),
    ("python-services/workloads.yaml", "retail-forecast", "services/python/retail-forecast", "python"),
    ("python-services/workloads.yaml", "speech-runtime", "services/python/speech-runtime", "python"),
    ("python-services/workloads.yaml", "ride-payment-webhook", "services/python/payment-webhook", "python"),
    ("python-services/workloads.yaml", "compliance-review", "services/python/compliance-review", "python"),
    ("pricing-dispatch/workloads.yaml", "pricing-engine", "services/rust/pricing-engine", "rust"),
    ("pricing-dispatch/workloads.yaml", "dispatch-optimizer", "services/rust/dispatch-optimizer", "rust"),
    ("tracker-ingest/workloads.yaml", "vehicle-tracker-ingest", "server", "typescript"),
    ("central/workloads.yaml", "central-app", "server", "typescript"),
]

ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]+$")
ENVISH_LITERAL = re.compile(r'"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)"')

GO_ENV_CALLS = re.compile(
    r'(?:os\.(?:Getenv|LookupEnv)|getEnv|getenv|getenvInt|getenvBool|getenvFloat|required)\(\s*"([A-Z][A-Z0-9_]+)"'
)
PYTHON_ENV_CALLS = re.compile(
    r'os\.(?:getenv|environ\.get)\(\s*["\']([A-Z][A-Z0-9_]+)["\']'
    r"|os\.environ\[\s*[\"']([A-Z][A-Z0-9_]+)[\"']\s*\]"
)
RUST_ENV_CALLS = re.compile(r'env::(?:var|var_os)\(\s*"([A-Z][A-Z0-9_]+)"')
TS_ENV_CALLS = re.compile(
    r'process\.env\.([A-Z][A-Z0-9_]+)'
    r"|process\.env\[\s*[\"']([A-Z][A-Z0-9_]+)[\"']\s*\]"
    r"|getRequiredEnv\(\s*[\"']([A-Z][A-Z0-9_]+)[\"']"
)

GO_REQUIRED_TABLE = re.compile(r"requiredEnvironmentVariables\s*=\s*\[\]string\{(.*?)\}", re.DOTALL)
PYTHON_REQUIRED_TABLE = re.compile(r"REQUIRED_ENV_VARS\s*=\s*\((.*?)\)", re.DOTALL)
RUST_REQUIRED_TABLE = re.compile(r"REQUIRED_ENV_VARS:\s*&\[&str\]\s*=\s*&\[(.*?)\]", re.DOTALL)
QUOTED_NAME = re.compile(r'["\']([A-Z][A-Z0-9_]+)["\']')

# mojaloop funds-outbox destinations -> per-destination required variables.
OUTBOX_DESTINATION_MAP = re.compile(r'"(dapr|kafka|fluvio|temporal)":\s*\{([^}]*)\}')


def iter_sources(service_dir: Path, suffixes: tuple[str, ...]) -> list[Path]:
    if not service_dir.is_dir():
        raise SystemExit(f"service source directory is missing: {service_dir}")
    return sorted(
        path
        for path in service_dir.rglob("*")
        if path.suffix in suffixes and "node_modules" not in path.parts
    )


def read_set(service_dir: Path, language: str) -> set[str]:
    """Every environment variable the service code may read at runtime."""
    found: set[str] = set()
    if language == "go":
        patterns: tuple[re.Pattern[str], ...] = (GO_ENV_CALLS,)
        suffixes = (".go",)
    elif language == "python":
        patterns = (PYTHON_ENV_CALLS,)
        suffixes = (".py",)
    elif language == "rust":
        patterns = (RUST_ENV_CALLS,)
        suffixes = (".rs",)
    elif language == "typescript":
        patterns = (TS_ENV_CALLS,)
        suffixes = (".ts",)
    else:  # pragma: no cover - registry guard
        raise SystemExit(f"unknown language: {language}")
    for path in iter_sources(service_dir, suffixes):
        text = path.read_text(encoding="utf-8", errors="replace")
        for pattern in patterns:
            for match in pattern.finditer(text):
                found.update(group for group in match.groups() if group)
        # Environment-like string literals cover helper maps such as the
        # mojaloop fundsOutboxDestinationEnvVars table where the variable
        # name appears as a bare literal.
        found.update(ENVISH_LITERAL.findall(text))
        if language == "rust" and "EnvFilter::from_default_env" in text:
            # tracing_subscriber reads RUST_LOG implicitly.
            found.add("RUST_LOG")
    # Container launch commands may consume variables (for example the
    # python Dockerfile's `--port ${PORT:-8000}`) without the service code
    # ever reading them.
    dockerfile_vars: set[str] = set()
    for dockerfile in (service_dir / "Dockerfile", service_dir.parent / "Dockerfile"):
        if dockerfile.is_file():
            dockerfile_vars.update(
                re.findall(r"\$\{?([A-Z][A-Z0-9_]+)", dockerfile.read_text(encoding="utf-8", errors="replace"))
            )
    found.update(dockerfile_vars)
    return found


def required_set(service_dir: Path, language: str) -> set[str]:
    """The service's declared boot-time required variables, if any."""
    table_pattern = {
        "go": GO_REQUIRED_TABLE,
        "python": PYTHON_REQUIRED_TABLE,
        "rust": RUST_REQUIRED_TABLE,
    }.get(language)
    if table_pattern is None:
        return set()
    suffixes = {"go": (".go",), "python": (".py",), "rust": (".rs",)}[language]
    required: set[str] = set()
    for path in iter_sources(service_dir, suffixes):
        text = path.read_text(encoding="utf-8", errors="replace")
        for match in table_pattern.finditer(text):
            required.update(QUOTED_NAME.findall(match.group(1)))
    return required


def load_documents(path: Path) -> list[dict[str, Any]]:
    try:
        documents = list(yaml.safe_load_all(path.read_text(encoding="utf-8")))
    except yaml.YAMLError:
        # Templated manifests (helm-style placeholders, vendor bundles) are
        # outside the static contract scope.
        return []
    return [
        document
        for document in documents
        if isinstance(document, dict) and document.get("kind")
    ]


def collect_config_keys() -> tuple[dict[str, set[str]], dict[str, set[str]]]:
    """ConfigMap data keys and Secret (template) stringData/data keys by name."""
    configmaps: dict[str, set[str]] = {}
    secrets: dict[str, set[str]] = {}
    for path in sorted(KUBERNETES_ROOT.rglob("*.yaml")):
        for document in load_documents(path):
            name = (document.get("metadata") or {}).get("name")
            if not name:
                continue
            if document["kind"] == "ConfigMap":
                configmaps.setdefault(name, set()).update((document.get("data") or {}).keys())
            elif document["kind"] == "Secret":
                keys = set((document.get("stringData") or {}).keys()) | set((document.get("data") or {}).keys())
                secrets.setdefault(name, set()).update(keys)
    return configmaps, secrets


def deployment_by_name(path: Path, name: str) -> dict[str, Any]:
    for document in load_documents(path):
        if document["kind"] == "Deployment" and (document.get("metadata") or {}).get("name") == name:
            return document
    raise SystemExit(f"Deployment {name} not found in {path}")


def provided_vars(
    deployment: dict[str, Any],
    configmaps: dict[str, set[str]],
    secrets: dict[str, set[str]],
) -> tuple[set[str], set[str], bool]:
    """(inline env names, envFrom-contributed keys, has unknown secret)."""
    inline: set[str] = set()
    contributed: set[str] = set()
    unknown_secret = False
    containers = deployment["spec"]["template"]["spec"].get("containers") or []
    for container in containers:
        for entry in container.get("env") or []:
            name = entry.get("name")
            if name and ENV_NAME.match(name):
                inline.add(name)
        for ref in container.get("envFrom") or []:
            if "configMapRef" in ref:
                cm_name = ref["configMapRef"].get("name", "")
                if cm_name in configmaps:
                    contributed.update(configmaps[cm_name])
                else:
                    unknown_secret = True  # unresolved reference: do not fail closed
            elif "secretRef" in ref:
                secret_name = ref["secretRef"].get("name", "")
                if secret_name in secrets:
                    contributed.update(secrets[secret_name])
                else:
                    unknown_secret = True
    # inline env valueFrom secretKeyRef may reference a secret we cannot see.
    for container in containers:
        for entry in container.get("env") or []:
            value_from = entry.get("valueFrom") or {}
            secret_ref = value_from.get("secretKeyRef")
            if secret_ref and secret_ref.get("name") not in secrets:
                unknown_secret = True
    return inline, contributed, unknown_secret


def main() -> int:
    configmaps, secrets = collect_config_keys()
    failures: list[str] = []

    service_reads: dict[str, set[str]] = {}
    service_required: dict[str, set[str]] = {}
    for _, deployment_name, service_dir_name, language in DEPLOYMENT_SERVICES:
        key = f"{service_dir_name}"
        if key not in service_reads:
            service_dir = ROOT / service_dir_name
            service_reads[key] = read_set(service_dir, language)
            service_required[key] = required_set(service_dir, language)

    # Consumers of each shared ConfigMap/Secret for the dead-key check.
    contributor_consumers: dict[str, set[str]] = {}

    for manifest_rel, deployment_name, service_dir_name, language in DEPLOYMENT_SERVICES:
        manifest_path = KUBERNETES_ROOT / manifest_rel
        deployment = deployment_by_name(manifest_path, deployment_name)
        inline, contributed, unknown_secret = provided_vars(deployment, configmaps, secrets)
        reads = service_reads[service_dir_name]
        required = set(service_required[service_dir_name])

        if deployment_name == "mojaloop-funds-outbox":
            # The outbox worker additionally requires the per-destination
            # variables for every enabled FUNDS_OUTBOX_DESTINATIONS entry.
            main_go = (ROOT / service_dir_name / "funds_outbox.go").read_text(encoding="utf-8")
            destination_map = {
                match.group(1): set(QUOTED_NAME.findall(match.group(2)))
                for match in OUTBOX_DESTINATION_MAP.finditer(main_go)
            }
            destinations = set()
            for source in (inline | contributed):
                if source == "FUNDS_OUTBOX_DESTINATIONS":
                    for container in deployment["spec"]["template"]["spec"].get("containers") or []:
                        for ref in container.get("envFrom") or []:
                            cm_name = (ref.get("configMapRef") or {}).get("name", "")
                            raw = ""
                            for path in sorted(KUBERNETES_ROOT.rglob("*.yaml")):
                                for document in load_documents(path):
                                    if document["kind"] == "ConfigMap" and (document.get("metadata") or {}).get("name") == cm_name:
                                        raw = (document.get("data") or {}).get("FUNDS_OUTBOX_DESTINATIONS", "") or raw
                            destinations.update(item.strip() for item in raw.split(",") if item.strip())
            for destination in sorted(destinations):
                required.update(destination_map.get(destination, set()))

        provided = inline | contributed
        if not unknown_secret:
            for name in sorted(required):
                if name not in provided:
                    failures.append(
                        f"{deployment_name} ({manifest_rel}): required variable {name} "
                        f"read by {service_dir_name} is not provided by the Deployment"
                    )
        for name in sorted(inline):
            if name not in reads:
                failures.append(
                    f"{deployment_name} ({manifest_rel}): inline env {name} is never read "
                    f"by {service_dir_name}"
                )
        for container in deployment["spec"]["template"]["spec"].get("containers") or []:
            for ref in container.get("envFrom") or []:
                ref_name = (ref.get("configMapRef") or ref.get("secretRef") or {}).get("name")
                if ref_name:
                    contributor_consumers.setdefault(ref_name, set()).add(service_dir_name)

    # Dead shared-config keys: a ConfigMap/Secret-template key that no
    # consuming service ever reads.
    for contributor, consumers in sorted(contributor_consumers.items()):
        keys = configmaps.get(contributor) or secrets.get(contributor) or set()
        combined_reads: set[str] = set()
        for service_dir_name in consumers:
            combined_reads.update(service_reads.get(service_dir_name, set()))
        for key in sorted(keys):
            if key not in combined_reads:
                failures.append(
                    f"{contributor}: key {key} is provided to {sorted(consumers)} "
                    "but never read by any of them"
                )

    if failures:
        print("configuration contract violations:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print(
        f"configuration contract ok: {len(DEPLOYMENT_SERVICES)} deployments, "
        f"{len(contributor_consumers)} shared config contributors checked"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
