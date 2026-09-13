#!/usr/bin/env bash
# Verify the hardening policy accepts a digest-pinned image and rejects a tag.
set -euo pipefail

policy_dir="policy/kubernetes"
fixture="policy/kubernetes-test/digest-rule-fixtures.yaml"
result="$(mktemp)"
trap 'rm -f "$result"' EXIT

set +e
conftest test --policy "$policy_dir" "$fixture" >"$result" 2>&1
status=$?
set -e
cat "$result"

if grep -qE 'rego_parse_error|rego_compile_error' "$result"; then
  echo "Kubernetes hardening policy failed to compile" >&2
  exit 1
fi
if [[ "$status" -eq 0 ]]; then
  echo "Expected mutable-tag fixture rejection was not observed" >&2
  exit 1
fi
if ! grep -Fq 'Deployment/bad-digest container "service" image must be pinned by sha256 digest' "$result"; then
  echo "Expected mutable-tag rejection message was not found" >&2
  exit 1
fi
if grep -Fq 'Deployment/digest-pinned container "service" image must be pinned by sha256 digest' "$result"; then
  echo "Digest-pinned fixture was falsely rejected" >&2
  exit 1
fi

echo "kubernetes_hardening_policy=PASS valid_digest_accepted=1 mutable_tag_rejected=1"
