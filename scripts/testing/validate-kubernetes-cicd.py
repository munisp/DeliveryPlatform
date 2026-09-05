#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

import yaml

path = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "kubernetes-cicd.yml"
workflow = yaml.safe_load(path.read_text(encoding="utf-8"))
if not isinstance(workflow, dict):
    raise SystemExit("workflow must be a YAML mapping")
jobs = workflow.get("jobs")
if not isinstance(jobs, dict):
    raise SystemExit("workflow has no jobs mapping")
for required in ("validate", "build-and-publish", "deploy-staging"):
    if required not in jobs:
        raise SystemExit(f"missing required job: {required}")

validate_steps = "\n".join(str(step) for step in jobs["validate"].get("steps", []))
for required in (
    "pnpm check",
    "pnpm build",
    "go test -race",
    "cargo test --locked",
    "validate-kubernetes-manifests.py",
    "simulate-kubernetes-node-failure.py",
    "validate-kubernetes-security.py",
    "audit-production-readiness.sh",
    "trivy-action",
):
    if required not in validate_steps:
        raise SystemExit(f"validation job is missing required gate: {required}")

build_permissions = jobs["build-and-publish"].get("permissions", {})
if build_permissions.get("packages") != "write" or build_permissions.get("id-token") != "write":
    raise SystemExit("build job requires package publication and OIDC attestation permissions")

deploy = jobs["deploy-staging"]
if deploy.get("environment") != "staging" or deploy.get("permissions", {}).get("id-token") != "write":
    raise SystemExit("deployment job must use protected staging environment with OIDC permission")
deploy_steps = "\n".join(str(step) for step in deploy.get("steps", []))
for required in (
    "kubectl auth can-i get secrets -n switchos && exit 1 || true",
    "externalsecrets.external-secrets.io",
    "kubectl wait --for=condition=Ready externalsecret",
    "deliveryplatform-schema-migration-${GITHUB_SHA::12}",
    "kubectl rollout status",
):
    if required not in deploy_steps:
        raise SystemExit(f"deployment job is missing required control: {required}")

print("GitHub Actions Kubernetes CI/CD validation passed: required build, test, scan, secret, migration, and protected rollout controls are present")
