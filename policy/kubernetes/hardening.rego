package main

import rego.v1

hardening_workload_kinds := {"Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"}
rbac_rule_kinds := {"Role", "ClusterRole"}
binding_kinds := {"RoleBinding", "ClusterRoleBinding"}
hardening_allowed_namespaces := {"switchos", "monitoring", "external-secrets", "ray-system"}
allowed_image_prefixes := {"ghcr.io/munisp/", "registry.deliveryplatform.example/"}
forbidden_rbac_verbs := {"bind", "escalate", "impersonate"}

# Run this policy with: conftest test --combine --policy policy rendered.yaml
# The --combine form passes all manifest documents as one input array, enabling
# namespace-wide NetworkPolicy assertions.

workload_pod_spec := spec if {
  input.kind in hardening_workload_kinds
  input.kind == "CronJob"
  spec := input.spec.jobTemplate.spec.template.spec
}

workload_pod_spec := spec if {
  input.kind in hardening_workload_kinds
  input.kind != "CronJob"
  spec := input.spec.template.spec
}

image_from_approved_registry(image) if {
  prefix := allowed_image_prefixes[_]
  startswith(image, prefix)
}

image_is_digest_pinned(image) if {
  regex.match("^.+@sha256:[0-9a-f]{64}$", image)
}

has_all_capabilities_dropped(container) if {
  "ALL" in object.get(object.get(container.securityContext, "capabilities", {}), "drop", [])
}

has_no_capability_additions(container) if {
  count(object.get(object.get(container.securityContext, "capabilities", {}), "add", [])) == 0
}

# Reject placeholders, mutable tags, unapproved registries, and non-digest images.
deny contains message if {
  input.kind in hardening_workload_kinds
  pod := workload_pod_spec
  container := pod.containers[_]
  not image_from_approved_registry(container.image)
  message := sprintf("%s/%s container %q image must use an approved registry", [input.kind, input.metadata.name, container.name])
}

deny contains message if {
  input.kind in hardening_workload_kinds
  pod := workload_pod_spec
  container := pod.containers[_]
  not image_is_digest_pinned(container.image)
  message := sprintf("%s/%s container %q image must be pinned by sha256 digest", [input.kind, input.metadata.name, container.name])
}

# Require complete pod hardening rather than only runAsNonRoot and readonly root.
deny contains message if {
  input.kind in hardening_workload_kinds
  pod := workload_pod_spec
  object.get(pod, "automountServiceAccountToken", true)
  message := sprintf("%s/%s must disable automountServiceAccountToken", [input.kind, input.metadata.name])
}

deny contains message if {
  input.kind in hardening_workload_kinds
  pod := workload_pod_spec
  object.get(pod.securityContext, "runAsUser", 0) == 0
  message := sprintf("%s/%s must set a non-zero runAsUser", [input.kind, input.metadata.name])
}

deny contains message if {
  input.kind in hardening_workload_kinds
  pod := workload_pod_spec
  object.get(pod.securityContext, "runAsGroup", 0) == 0
  message := sprintf("%s/%s must set a non-zero runAsGroup", [input.kind, input.metadata.name])
}

deny contains message if {
  input.kind in hardening_workload_kinds
  pod := workload_pod_spec
  object.get(object.get(pod.securityContext, "seccompProfile", {}), "type", "") != "RuntimeDefault"
  message := sprintf("%s/%s must set pod seccompProfile.type=RuntimeDefault", [input.kind, input.metadata.name])
}

deny contains message if {
  input.kind in hardening_workload_kinds
  pod := workload_pod_spec
  container := pod.containers[_]
  not has_all_capabilities_dropped(container)
  message := sprintf("%s/%s container %q must drop ALL Linux capabilities", [input.kind, input.metadata.name, container.name])
}

deny contains message if {
  input.kind in hardening_workload_kinds
  pod := workload_pod_spec
  container := pod.containers[_]
  not has_no_capability_additions(container)
  message := sprintf("%s/%s container %q must not add Linux capabilities", [input.kind, input.metadata.name, container.name])
}

deny contains message if {
  input.kind in hardening_workload_kinds
  pod := workload_pod_spec
  object.get(pod, "hostNetwork", false) == true
  message := sprintf("%s/%s must not use hostNetwork", [input.kind, input.metadata.name])
}

deny contains message if {
  input.kind in hardening_workload_kinds
  pod := workload_pod_spec
  object.get(pod, "hostPID", false) == true
  message := sprintf("%s/%s must not use hostPID", [input.kind, input.metadata.name])
}

deny contains message if {
  input.kind in hardening_workload_kinds
  pod := workload_pod_spec
  object.get(pod, "hostIPC", false) == true
  message := sprintf("%s/%s must not use hostIPC", [input.kind, input.metadata.name])
}

deny contains message if {
  input.kind in hardening_workload_kinds
  pod := workload_pod_spec
  volume := object.get(pod, "volumes", [])[_]
  object.get(volume, "hostPath", null) != null
  message := sprintf("%s/%s must not use hostPath volume %q", [input.kind, input.metadata.name, volume.name])
}

deny contains message if {
  input.kind in hardening_workload_kinds
  pod := workload_pod_spec
  container := pod.containers[_]
  object.get(container.securityContext, "privileged", false) == true
  message := sprintf("%s/%s container %q must not be privileged", [input.kind, input.metadata.name, container.name])
}

# Apply least privilege to both namespaced and cluster-wide RBAC roles.
deny contains message if {
  input.kind in rbac_rule_kinds
  rule := input.rules[_]
  verb := object.get(rule, "verbs", [])[_]
  verb in forbidden_rbac_verbs
  message := sprintf("%s/%s may not grant %q", [input.kind, input.metadata.name, verb])
}

deny contains message if {
  input.kind in rbac_rule_kinds
  rule := input.rules[_]
  "secrets" in object.get(rule, "resources", [])
  count(object.get(rule, "resourceNames", [])) == 0
  message := sprintf("%s/%s must scope Secret access using resourceNames", [input.kind, input.metadata.name])
}

deny contains message if {
  input.kind in rbac_rule_kinds
  rule := input.rules[_]
  "*" in object.get(rule, "nonResourceURLs", [])
  message := sprintf("%s/%s must not grant wildcard non-resource URLs", [input.kind, input.metadata.name])
}

# Binding subjects must be explicit; broad system groups are never an application binding.
deny contains message if {
  input.kind in binding_kinds
  subject := object.get(input, "subjects", [])[_]
  subject.kind == "Group"
  startswith(subject.name, "system:")
  message := sprintf("%s/%s must not bind broad system group %q", [input.kind, input.metadata.name, subject.name])
}

deny contains message if {
  input.kind in binding_kinds
  subject := object.get(input, "subjects", [])[_]
  subject.kind == "ServiceAccount"
  not subject.namespace in hardening_allowed_namespaces
  message := sprintf("%s/%s binds ServiceAccount %q outside approved namespaces", [input.kind, input.metadata.name, subject.name])
}

# Apply namespace constraint to all named namespaced resources, not workloads alone.
namespaced_resource_kinds := {"ConfigMap", "Service", "ServiceAccount", "Role", "RoleBinding", "NetworkPolicy", "ExternalSecret", "ServiceMonitor", "PrometheusRule", "RayJob"}

deny contains message if {
  input.kind in namespaced_resource_kinds
  namespace := object.get(input.metadata, "namespace", "default")
  not namespace in hardening_allowed_namespaces
  message := sprintf("%s/%s uses namespace %q outside the approved set", [input.kind, input.metadata.name, namespace])
}

# Recursively deny TLS-verification bypasses, including nested custom-resource fields.
deny contains message if {
  walk(input, [path, value])
  count(path) > 0
  path[count(path) - 1] == "insecureSkipTLSVerify"
  value == true
  message := sprintf("%s/%s contains insecureSkipTLSVerify=true at %v", [input.kind, input.metadata.name, path])
}

# Pin ExternalSecret usage to the approved cluster store and retain target data when
# the operator is removed. Update this name only through a reviewed environment policy.
deny contains message if {
  input.kind == "ExternalSecret"
  input.spec.secretStoreRef.kind != "ClusterSecretStore"
  message := sprintf("ExternalSecret/%s must use an approved ClusterSecretStore", [input.metadata.name])
}

deny contains message if {
  input.kind == "ExternalSecret"
  input.spec.secretStoreRef.name != "deliveryplatform-secrets"
  message := sprintf("ExternalSecret/%s must use deliveryplatform-secrets", [input.metadata.name])
}

deny contains message if {
  input.kind == "ExternalSecret"
  object.get(object.get(input.spec, "target", {}), "deletionPolicy", "") != "Retain"
  message := sprintf("ExternalSecret/%s must retain target Secret data on deletion", [input.metadata.name])
}

# Combined-document checks. These must evaluate a rendered multi-document input
# with conftest --combine, not one resource at a time.
documents_from_contents(contents) := contents if {
  is_array(contents)
}

documents_from_contents(contents) := [contents] if {
  is_object(contents)
}

combined_documents := documents if {
  is_array(input)
  documents := [document |
    entry := input[_]
    document := documents_from_contents(entry.contents)[_]
  ]
}

workload_namespace_set := {namespace |
  document := combined_documents[_]
  document.kind in hardening_workload_kinds
  namespace := object.get(document.metadata, "namespace", "default")
}

has_default_deny_ingress(namespace) if {
  document := combined_documents[_]
  document.kind == "NetworkPolicy"
  object.get(document.metadata, "namespace", "default") == namespace
  object.get(document.spec, "podSelector", {}) == {}
  "Ingress" in object.get(document.spec, "policyTypes", [])
}

has_default_deny_egress(namespace) if {
  document := combined_documents[_]
  document.kind == "NetworkPolicy"
  object.get(document.metadata, "namespace", "default") == namespace
  object.get(document.spec, "podSelector", {}) == {}
  "Egress" in object.get(document.spec, "policyTypes", [])
}

deny contains message if {
  namespace := workload_namespace_set[_]
  not has_default_deny_ingress(namespace)
  message := sprintf("namespace %q has workloads but lacks a default-deny ingress NetworkPolicy", [namespace])
}

deny contains message if {
  namespace := workload_namespace_set[_]
  not has_default_deny_egress(namespace)
  message := sprintf("namespace %q has workloads but lacks a default-deny egress NetworkPolicy", [namespace])
}
