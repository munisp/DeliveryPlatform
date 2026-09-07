# Resilience Correlation Logging and Alert-Driven Circuit Breaker Design

**Author:** Manus AI  
**Date:** 2026-09-03  
**Scope:** Protected staging resilience validation only. This document describes the implemented request-correlation changes and an approval-gated design for opening the validation circuit breaker from an invariant alert. It does not authorize production fault injection, provider actions, payment state changes, or automatic circuit-breaker closure.

## 1. Correlation contract

The shared contract is intentionally small. `X-Resilience-Run-Id` identifies a single approved, non-production validation run. `X-Request-Id` identifies an individual request. Both are restricted to 3–81 ASCII alphanumeric, dot, underscore, or hyphen characters. Invalid values are ignored; a server-generated request ID is used when a request ID is absent or invalid.

Only metadata is logged. The contract forbids using correlation fields for authentication, authorization, payment idempotency, routing policy, driver selection, financial decisions, or database partitioning. Neither service logs raw headers, body content, signatures, credentials, card data, private keys, document references, or precise location payloads merely to support a resilience run.

| Component | Implemented change | Effect |
|---|---|---|
| Go ride matching worker | Added request-context middleware, response propagation, and JSON events for request completion, matching success/failure, Redis fallback, and post-commit offer-projection failure. | A matching run can be joined by `resilience_run_id`, `request_id`, trip/offer identifiers, and safe error class. |
| Python payment webhook | Added ContextVar correlation handling; migration `0039`; durable `resilience_run_id`/`request_id` queue fields; restoration in asynchronous verification; JSON acceptance/deferred/quarantine/verified events. | The callback and later provider-verification result retain the same run identity without trusting callback data for money state. |
| Python compliance review | Added bounded inbound-header validation, response propagation, and run-scoped HTTP completion JSON events. | The central app’s compliance calls remain traceable through the internal boundary. |
| Rust dispatch optimizer and pricing engine | Added Axum middleware, generated correlation IDs, response headers, and request-scoped `tracing` spans. | Existing and future `tracing` events inside handlers inherit the request/run fields. |
| TypeScript operator API | Added validated non-production run context, safe response propagation, run-scoped JSON completion logging, and downstream forwarding to dispatch and compliance. | A validated staging run can flow from the operator API to its current internal service calls. |

The TypeScript central API deliberately drops inbound resilience-run headers when `ENV.isProduction` is true. The direct staging endpoints must remain reachable only through the protected test ingress. For direct Go/Python/Rust staging service tests, the mTLS/ingress policy and internal test token provide the trust boundary; the field is audit metadata, not a privilege.

## 2. Migration and service rollout order

Apply `0039_payment_webhook_correlation.sql` after `0038_payment_webhook_verification_queue.sql` and before rolling payment-webhook replicas that persist the new columns. The migration is additive, nullable, indexed by provider/run/received time, and does not rewrite existing payment, ledger, payout, or raw webhook facts.

Deploy in this order: schema migration; Python webhook service; Go worker; Rust services; TypeScript operator service; then the staging ingress and log pipeline parsers. Roll back application images before dropping no data columns; column removal is not required for an application rollback because nullable additive columns are backward compatible.

## 3. Alert-triggered circuit breaker: required architecture

Prometheus rules evaluate metrics and Alertmanager sends notifications. Neither component should receive Kubernetes permissions to patch ConfigMaps. The existing PrometheusRule therefore uses only alert annotations such as `circuit_breaker: open`; it cannot and must not mutate cluster state by itself.

> **Fail-closed invariant:** an automated path may open `resilience-validation-circuit-breaker` after an authenticated, allowlisted critical alert. It must never close it. Closure remains a separate operator action that records recovery evidence.

| Approach | Trade-offs | Cost | Setup complexity |
|---|---|---:|---:|
| **Authenticated in-cluster receiver** | Alertmanager sends an allowlisted webhook to a dedicated receiver. The receiver has namespace-local permission to patch exactly one ConfigMap and persists a Kubernetes Event/audit log. This provides fast, deterministic opening. | Open-source components; operating cost only. | Medium; requires a reviewed receiver deployment, Service, network policy, token/identity, and tests. |
| **Manual breaker command after critical alert** | SRE runs the existing guarded breaker command after acknowledging the alert. It is slower but has the smallest privilege and operational surface. | No additional service. | Low; appropriate until the receiver has security review. |

The first approach is appropriate only after formal threat modeling. The second is the safer immediate staging choice. Do not deploy both mutation paths with overlapping authority.

### 3.1 Exact receiver acceptance policy

A future receiver shall reject every notification unless all conditions hold:

1. The request is authenticated using a dedicated secret or workload identity; it is not an unauthenticated cluster Service.
2. The Alertmanager source namespace, receiver route, TLS server name, and client identity are allowlisted.
3. At least one alert is `status=firing`, `severity=critical`, `namespace=resilience-test`, and `alertname` is one of `ResilienceInvariantProbeFailed`, `ResilienceInvariantProbeStalled`, or `ResilienceInvariantProbeMissing`.
4. The alert labels include `circuit_breaker=open` and `resilience.delivery-platform.io/environment=non-production`.
5. The target is exactly `resilience-test/resilience-validation-circuit-breaker`.
6. The receiver performs an idempotent JSON Patch that changes `data.state` only from `closed` to `open`, and writes the immutable opening fields: alert fingerprint, incident ID, opened timestamp, actor `alertmanager-receiver`, and an allowlisted reason.
7. A firing notification after the breaker is already open returns success without changing its original opening evidence.
8. Resolved alerts, warning alerts, unknown labels, foreign namespaces, and close requests cannot change the ConfigMap.

The receiver’s Role must be namespaced and contain only `get` and `patch` on the sole ConfigMap name through `resourceNames`. It must not list/get Secrets, create Pods or Jobs, delete TestRuns, patch Deployments, or access any production namespace. NetworkPolicy must admit ingress solely from the Alertmanager workload and deny all unrelated traffic. The Service must use TLS; use a short-lived workload identity rather than a static bearer token if the target cluster supports it.

### 3.2 Alertmanager route requirements

The Alertmanager configuration route must select only the three critical invariant alert names and namespace label. It should set a short `group_wait` (for example, 10 seconds) while preserving standard human paging in parallel. The receiver payload should include common and per-alert labels/annotations, run/change identifiers, the Prometheus external URL, starts-at time, and fingerprint. It must not include raw SQL result content, webhook payloads, signed headers, payment references, driver locations, or credentials.

A deployment gate keeps the independent safety net: it reads the ConfigMap and refuses schema migration or rollout while the state is not exactly `closed`. Alert automation opens the gate; it cannot bypass it or close it.

## 4. Prometheus alert prerequisites

The checked-in rules use `kube_job_status_failed`, `kube_job_status_start_time`, and `kube_job_status_completion_time` from kube-state-metrics. Before activating the rules, verify that these series are scraped and carry `namespace=resilience-test` and a `job_name` beginning with `resilience-invariant-`. Configure alert routing so the severity and circuit-breaker labels survive grouping and inhibition.

Application-specific financial and assignment integrity remains proven by the PostgreSQL invariant Job. Do not derive financial correctness from log counts. Add service metrics only after they are emitted and tested: `payment_webhook_queue_oldest_seconds`, `payment_webhook_terminal_total`, matching request duration buckets, Redis fallback counter, and correlation-log ingestion/parse-error counters.

## 5. Validation evidence and remaining limits

The repository checks passed after these changes: Go race tests, Python compilation, eight database-backed payment webhook tests including durable correlation persistence, Rust dispatch/pricing tests, TypeScript type checking, resilience-template validation, and whitespace checking. The local run did not validate a staging ingress, alertmanager receiver, mTLS identity, kube-state-metrics scrape, external log collector, or automatic ConfigMap mutation.

The exact runbook and SRE query document remain authoritative for live-staging preparation. Alert-driven opening must be exercised first against an isolated namespace with a deliberately failing invariant Job and evidence that the receiver cannot close the breaker or mutate any other resource.

## References

[1] [Prometheus Alertmanager configuration — webhook receivers](https://prometheus.io/docs/alerting/latest/configuration/)  
[2] [Prometheus Operator alerting configuration](https://prometheus-operator.dev/docs/developer/alerting/)  
[3] [Kubernetes RBAC authorization reference](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)  
[4] [Kubernetes RBAC good practices](https://kubernetes.io/docs/concepts/security/rbac-good-practices/)
