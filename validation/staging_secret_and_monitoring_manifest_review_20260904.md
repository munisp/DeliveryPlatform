# Staging ExternalSecret and Prometheus/Alertmanager Manifest Review

**Date:** 2026-09-04  
**Scope:** `deploy/kubernetes/staging-monitoring/external-secrets.yaml` and `prometheus-alertmanager.yaml`, plus their direct references in the guarded staging provisioner and resilience AlertmanagerConfig.

## Verdict

The manifests are correctly structured for **test-only staging inputs**. No bearer token, private key, certificate body, provider credential, or production secret value is embedded in either manifest. The provisioning script rejects incomplete inputs before it calls Kubernetes and performs placeholder replacement only in a temporary render directory.

One least-privilege refinement was applied during review: the monitoring egress rule is now restricted to the exact circuit-breaker receiver, Matrix bridge, and Wazuh bridge pod labels in `resilience-test`, rather than permitting TCP 8443 to every pod in that namespace.

## ExternalSecret Contracts

| Target Secret                                   | Namespace         | Remote secret path                                                       | Key(s) created       | Review result                                                                                |
| ----------------------------------------------- | ----------------- | ------------------------------------------------------------------------ | -------------------- | -------------------------------------------------------------------------------------------- |
| `matrix-escalation-bridge-auth`                 | `monitoring`      | `deliveryplatform/staging/resilience/matrix-escalation-bridge`           | `token`              | Correct: stage-scoped reference; no embedded value                                           |
| `wazuh-escalation-bridge-auth`                  | `monitoring`      | `deliveryplatform/staging/resilience/wazuh-escalation-bridge`            | `token`              | Correct: stage-scoped reference; no embedded value                                           |
| `resilience-circuit-breaker-alert-receiver`     | `resilience-test` | `deliveryplatform/staging/resilience/circuit-breaker-alert-receiver`     | `token`              | Correct: receiver-specific test token only                                                   |
| `resilience-circuit-breaker-alert-receiver-tls` | `resilience-test` | `deliveryplatform/staging/resilience/circuit-breaker-alert-receiver-tls` | `tls.crt`, `tls.key` | Correct: private TLS material stays in the secret manager and renders as `kubernetes.io/tls` |

All four resources use `ClusterSecretStore/platform-staging-secrets`, set `creationPolicy: Owner`, and refresh at a bounded one-hour interval. This is correct only if the target cluster’s External Secrets deployment and `ClusterSecretStore` use staging-only workload identity and deny production secret paths.

## Public Trust Anchors

The receiver, Matrix, and Wazuh CAs are intentionally **not** declared as ExternalSecrets. Alertmanager `tlsConfig.ca` and ServiceMonitor `tlsConfig.ca` require ConfigMap references. The provisioner requires three readable approved CA PEM inputs and creates these ConfigMaps with `kubectl create configmap --dry-run=client -o yaml | kubectl apply -f -`:

| ConfigMap                                      | Namespace    | Consumer                                   |
| ---------------------------------------------- | ------------ | ------------------------------------------ |
| `resilience-circuit-breaker-alert-receiver-ca` | `monitoring` | Receiver `ServiceMonitor` HTTPS scrape     |
| `matrix-escalation-bridge-ca`                  | `monitoring` | Matrix Alertmanager webhook TLS validation |
| `wazuh-escalation-bridge-ca`                   | `monitoring` | Wazuh Alertmanager webhook TLS validation  |

`trust-bundles.yaml` is a documented input template only and is not included in the Kustomize apply list, preventing placeholder CA text from reaching a cluster.

## Prometheus and Alertmanager Inputs

| Field                        | Manifest placeholder or selector                               | Guardrail                                                            |
| ---------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| Prometheus image             | `REPLACE_WITH_APPROVED_PROMETHEUS_IMAGE_DIGEST`                | Provisioner accepts only `@sha256:` image references                 |
| Alertmanager image           | `REPLACE_WITH_APPROVED_ALERTMANAGER_IMAGE_DIGEST`              | Provisioner accepts only `@sha256:` image references                 |
| kube-state-metrics image     | `REPLACE_WITH_APPROVED_KUBE_STATE_METRICS_IMAGE_DIGEST`        | Provisioner accepts only `@sha256:` image references                 |
| Staging cluster identity     | `REPLACE_WITH_STAGING_CLUSTER_ID`                              | Required non-empty render input                                      |
| Monitoring storage class     | `REPLACE_WITH_STAGING_MONITORING_STORAGE_CLASS`                | Required non-empty render input                                      |
| Receiver image               | Replaced while rendering `circuit-breaker-alert-receiver.yaml` | Provisioner accepts only `@sha256:` image references                 |
| ServiceMonitor selection     | `prometheus: platform`                                         | Prometheus CR selects that exact label and non-production namespaces |
| Rule selection               | `prometheus: platform`                                         | Prometheus CR selects that exact label in `monitoring`               |
| AlertmanagerConfig selection | `alertmanagerConfig: enabled`                                  | Alertmanager CR selects that exact label in `monitoring`             |

The provisioner scans every temporary rendered YAML for `REPLACE_WITH_` and refuses a deployment if any remain.

## Network and Authority Boundaries

The Prometheus service account has Kubernetes discovery permissions only. The circuit-breaker receiver separately retains `get`/`patch` access only to `resilience-validation-circuit-breaker`. Matrix and Wazuh bridge service accounts remain tokenless and bind to an empty Role.

The monitoring egress policy now allows TCP 8443 only to these `resilience-test` pod identities:

1. `app.kubernetes.io/name=resilience-circuit-breaker-alert-receiver`
2. `app.kubernetes.io/name=matrix-escalation-bridge`
3. `app.kubernetes.io/name=wazuh-escalation-bridge`

Prometheus may also reach only same-namespace kube-state-metrics on TCP 8080 and kube-dns on UDP 53 under this policy.

## Remaining Required Staging Inputs

The manifests do not, and should not, create live credentials or bridge integrations. A protected staging deployment still requires:

1. An External Secrets Operator and a `platform-staging-secrets` ClusterSecretStore with staging-only identity and path policy.
2. Test-only remote token values satisfying the receiver’s configured minimum token length.
3. A staging PKI-issued receiver certificate/private key and approved CA PEM bundles.
4. Real Matrix and Wazuh bridge Deployments/Services carrying the exact pod labels referenced by the policy and matching the HTTPS hostnames in AlertmanagerConfig.
5. An actual Prometheus Operator/Prometheus/Alertmanager/kube-state-metrics control plane and an enforcing CNI.

The provisioner fails closed if the secret-store prerequisites, CA inputs, image digests, namespace labels, bundle checksum, or operator availability checks do not pass.
