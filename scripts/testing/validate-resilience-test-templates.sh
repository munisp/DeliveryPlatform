#!/usr/bin/env bash
# Validates the resilience-test manifest templates under deploy/kubernetes/resilience-test:
#   1. every YAML document is a well-formed Kubernetes resource (apiVersion, kind, metadata.name)
#   2. workload resources (Deployment/Job/StatefulSet/TestRun) are explicitly marked as
#      non-production or local-fixture so rehearsal workloads can never be confused with
#      production desired state
#   3. unresolved template placeholders are limited to the reviewed allowlist; any new
#      placeholder must be wired into the substitution tooling that renders it
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

python3 - "$ROOT" <<'PY'
import re
import sys
from pathlib import Path

import yaml

root = Path(sys.argv[1])
package = root / "deploy" / "kubernetes" / "resilience-test"

ALLOWED_PLACEHOLDERS = {
    "REPLACE_WITH_IMMUTABLE_RECEIVER_DIGEST",
    "RESILIENCE_INVARIANT_PROBE_JOB_NAME",
}
WORKLOAD_KINDS = {"Deployment", "Job", "StatefulSet", "TestRun"}
GUARD_LABELS = (
    "resilience.delivery-platform.io/environment",
    "resilience.delivery-platform.io/local-fixture",
)
PLACEHOLDER_PATTERN = re.compile(r"(?:REPLACE_WITH_[A-Z0-9_]+|RESILIENCE_[A-Z0-9_]+_JOB_NAME)")

errors = []
files = sorted(package.rglob("*.yaml"))
if not files:
    errors.append(f"no manifests found under {package}")

for path in files:
    text = path.read_text(encoding="utf-8")
    for placeholder in sorted(set(PLACEHOLDER_PATTERN.findall(text))):
        if placeholder not in ALLOWED_PLACEHOLDERS:
            errors.append(f"{path}: unreviewed template placeholder {placeholder}")
    try:
        documents = list(yaml.safe_load_all(text))
    except yaml.YAMLError as exc:
        errors.append(f"{path}: invalid YAML: {exc}")
        continue
    for index, document in enumerate(documents, start=1):
        if not isinstance(document, dict):
            errors.append(f"{path}:{index}: expected a YAML mapping")
            continue
        for field in ("apiVersion", "kind"):
            if not document.get(field):
                errors.append(f"{path}:{index}: missing {field}")
        metadata = document.get("metadata")
        if not isinstance(metadata, dict) or not metadata.get("name"):
            errors.append(f"{path}:{index}: resource requires metadata.name")
            continue
        if document.get("kind") in WORKLOAD_KINDS:
            labels = metadata.get("labels") or {}
            template_labels = (
                document.get("spec", {}).get("template", {}).get("metadata", {}).get("labels") or {}
            )
            if not any(label in labels or label in template_labels for label in GUARD_LABELS):
                errors.append(
                    f"{path}:{index}: {document['kind']}/{metadata['name']} lacks a non-production "
                    "or local-fixture guard label"
                )

if errors:
    for error in errors:
        print(f"resilience template validation failed: {error}", file=sys.stderr)
    raise SystemExit(1)

print(f"validated {len(files)} resilience-test manifest templates under {package}")
PY
