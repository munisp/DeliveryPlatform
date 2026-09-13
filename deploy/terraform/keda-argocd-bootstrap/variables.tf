variable "kubeconfig_path" {
  description = "Absolute path to a kubeconfig for a non-production or production cluster after separate change approval. Terraform does not create or discover cluster credentials."
  type        = string
  default     = null
  nullable    = true
}

variable "kubeconfig_context" {
  description = "Explicit kubeconfig context. Leave null only when the kubeconfig contains one unambiguous approved context."
  type        = string
  default     = null
  nullable    = true
}

variable "keda_namespace" {
  description = "Dedicated namespace for the KEDA operator and metrics server."
  type        = string
  default     = "keda"

  validation {
    condition     = can(regex("^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", var.keda_namespace))
    error_message = "keda_namespace must be a DNS-label-compatible Kubernetes namespace."
  }
}

variable "tracker_namespace" {
  description = "Namespace where the tracker workload, KEDA ScaledObject, and rollout gate run."
  type        = string
  default     = "switchos"

  validation {
    condition     = can(regex("^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", var.tracker_namespace))
    error_message = "tracker_namespace must be a DNS-label-compatible Kubernetes namespace."
  }
}

variable "keda_chart_version" {
  description = "Pinned KEDA Helm chart version. Upgrade only after CRD, scaler, and rehearsal validation."
  type        = string
  default     = "2.20.2"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.keda_chart_version))
    error_message = "keda_chart_version must be a pinned semantic version, not a floating tag."
  }
}

variable "kubernetes_api_cidrs" {
  description = "Approved private CIDRs that route to this cluster's Kubernetes API server. The gate NetworkPolicy never accepts a public catch-all."
  type        = list(string)

  validation {
    condition = length(var.kubernetes_api_cidrs) > 0 && alltrue([
      for cidr in var.kubernetes_api_cidrs : can(cidrhost(cidr, 0)) && cidr != "0.0.0.0/0" && cidr != "::/0"
    ])
    error_message = "kubernetes_api_cidrs must be non-empty valid CIDRs and must not contain a public catch-all."
  }
}
