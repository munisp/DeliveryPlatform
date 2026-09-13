terraform {
  required_version = ">= 1.6.0"

  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.16"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.31"
    }
  }
}

provider "kubernetes" {
  config_path    = var.kubeconfig_path
  config_context = var.kubeconfig_context
}

provider "helm" {
  kubernetes {
    config_path    = var.kubeconfig_path
    config_context = var.kubeconfig_context
  }
}

resource "kubernetes_namespace_v1" "keda" {
  metadata {
    name = var.keda_namespace
    labels = {
      "app.kubernetes.io/part-of" = "deliveryplatform"
      "pod-security.kubernetes.io/enforce" = "restricted"
      "pod-security.kubernetes.io/audit"   = "restricted"
      "pod-security.kubernetes.io/warn"    = "restricted"
    }
  }
}

resource "helm_release" "keda" {
  name             = "keda"
  namespace        = kubernetes_namespace_v1.keda.metadata[0].name
  repository       = "https://kedacore.github.io/charts"
  chart            = "keda"
  version          = var.keda_chart_version
  atomic           = true
  cleanup_on_fail  = true
  create_namespace = false
  wait             = true
  timeout          = 600
  max_history      = 5

  # Do not let a generic IaC reconciliation silently adopt a pre-existing
  # operator. Explicit import and change review are required instead.
  replace      = false
  force_update = false

  values = [yamlencode({
    watchNamespace = ""
    metricsServer = {
      replicaCount = 2
      resources = {
        requests = { cpu = "100m", memory = "128Mi" }
        limits   = { cpu = "500m", memory = "256Mi" }
      }
    }
    operator = {
      replicaCount = 2
      resources = {
        requests = { cpu = "100m", memory = "128Mi" }
        limits   = { cpu = "500m", memory = "256Mi" }
      }
    }
  })]
}

# The gate needs only DNS, the Kubernetes API CIDRs supplied by the cluster
# operator, and HTTPS to Prometheus inside the monitoring namespace. It never
# receives database, PgBouncer, provider, TigerBeetle, or vehicle-control access.
resource "kubernetes_network_policy_v1" "vehicle_tracker_rollout_gate_egress" {
  metadata {
    name      = "vehicle-tracker-rollout-gate-egress"
    namespace = var.tracker_namespace
    labels = {
      "app.kubernetes.io/name"      = "vehicle-tracker-rollout-gate"
      "app.kubernetes.io/component" = "deployment-safety"
      "app.kubernetes.io/part-of"   = "deliveryplatform"
    }
  }

  spec {
    pod_selector {
      match_labels = {
        "app.kubernetes.io/name"      = "vehicle-tracker-rollout-gate"
        "app.kubernetes.io/component" = "deployment-safety"
      }
    }

    policy_types = ["Egress"]

    egress {
      to {
        namespace_selector {
          match_labels = {
            "kubernetes.io/metadata.name" = "monitoring"
          }
        }
      }
      ports {
        protocol = "TCP"
        port     = "9090"
      }
    }

    egress {
      to {
        namespace_selector {
          match_labels = {
            "kubernetes.io/metadata.name" = "kube-system"
          }
        }
        pod_selector {
          match_labels = {
            "k8s-app" = "kube-dns"
          }
        }
      }
      ports {
        protocol = "UDP"
        port     = "53"
      }
      ports {
        protocol = "TCP"
        port     = "53"
      }
    }

    dynamic "egress" {
      for_each = toset(var.kubernetes_api_cidrs)
      content {
        to {
          ip_block {
            cidr = egress.value
          }
        }
        ports {
          protocol = "TCP"
          port     = "443"
        }
      }
    }
  }

  depends_on = [helm_release.keda]
}

output "keda_namespace" {
  description = "Namespace containing the installed KEDA operator and metrics server."
  value       = kubernetes_namespace_v1.keda.metadata[0].name
}

output "keda_chart_version" {
  description = "Pinned KEDA Helm chart version installed by this module."
  value       = helm_release.keda.version
}

output "rollout_gate_network_policy" {
  description = "Name of the egress-restricting policy required by the Argo CD rollout gate Job."
  value       = kubernetes_network_policy_v1.vehicle_tracker_rollout_gate_egress.metadata[0].name
}
