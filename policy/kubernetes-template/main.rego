package main

import rego.v1

allowed_namespaces := {"switchos"}
workload_kinds := {"Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"}

pod_spec := spec if {
  input.kind in workload_kinds
  input.kind == "CronJob"
  spec := input.spec.jobTemplate.spec.template.spec
}

pod_spec := spec if {
  input.kind in workload_kinds
  input.kind != "CronJob"
  spec := input.spec.template.spec
}

deny contains message if {
  input.kind in workload_kinds
  namespace := object.get(input.metadata, "namespace", "default")
  not namespace in allowed_namespaces
  message := sprintf("%s/%s uses namespace %q outside the allowed deployment scope", [input.kind, input.metadata.name, namespace])
}

deny contains message if {
  input.kind in workload_kinds
  spec := pod_spec
  not spec.securityContext.runAsNonRoot
  message := sprintf("%s/%s must set pod securityContext.runAsNonRoot=true", [input.kind, input.metadata.name])
}

deny contains message if {
  input.kind in workload_kinds
  spec := pod_spec
  container := spec.containers[_]
  not container.securityContext.allowPrivilegeEscalation == false
  message := sprintf("%s/%s container %q must set allowPrivilegeEscalation=false", [input.kind, input.metadata.name, container.name])
}

deny contains message if {
  input.kind in workload_kinds
  spec := pod_spec
  container := spec.containers[_]
  not container.securityContext.readOnlyRootFilesystem == true
  message := sprintf("%s/%s container %q must set readOnlyRootFilesystem=true", [input.kind, input.metadata.name, container.name])
}

deny contains message if {
  input.kind in workload_kinds
  spec := pod_spec
  container := spec.containers[_]
  not object.get(object.get(container, "resources", {}), "requests", {}).cpu
  message := sprintf("%s/%s container %q must define a CPU request", [input.kind, input.metadata.name, container.name])
}

deny contains message if {
  input.kind in workload_kinds
  spec := pod_spec
  container := spec.containers[_]
  not object.get(object.get(container, "resources", {}), "requests", {}).memory
  message := sprintf("%s/%s container %q must define a memory request", [input.kind, input.metadata.name, container.name])
}

deny contains message if {
  input.kind in workload_kinds
  spec := pod_spec
  container := spec.containers[_]
  not object.get(object.get(container, "resources", {}), "limits", {}).cpu
  message := sprintf("%s/%s container %q must define a CPU limit", [input.kind, input.metadata.name, container.name])
}

deny contains message if {
  input.kind in workload_kinds
  spec := pod_spec
  container := spec.containers[_]
  not object.get(object.get(container, "resources", {}), "limits", {}).memory
  message := sprintf("%s/%s container %q must define a memory limit", [input.kind, input.metadata.name, container.name])
}

deny contains message if {
  input.kind in workload_kinds
  spec := pod_spec
  container := spec.containers[_]
  endswith(container.image, ":latest")
  message := sprintf("%s/%s container %q must not use a :latest image", [input.kind, input.metadata.name, container.name])
}

deny contains message if {
  input.kind == "Role"
  rule := input.rules[_]
  "*" in object.get(rule, "apiGroups", [])
  message := sprintf("Role/%s must not use wildcard API groups", [input.metadata.name])
}

deny contains message if {
  input.kind == "Role"
  rule := input.rules[_]
  "*" in object.get(rule, "resources", [])
  message := sprintf("Role/%s must not use wildcard resources", [input.metadata.name])
}

deny contains message if {
  input.kind == "Role"
  rule := input.rules[_]
  "*" in object.get(rule, "verbs", [])
  message := sprintf("Role/%s must not use wildcard verbs", [input.metadata.name])
}

deny contains message if {
  object.get(input, "insecureSkipTLSVerify", false) == true
  message := sprintf("%s/%s must not set insecureSkipTLSVerify=true", [input.kind, input.metadata.name])
}
