# DeliveryPlatform Kubernetes Deployment Package

This directory contains Kubernetes workload packages for the central TypeScript application, six Go services, five Python services, and two Rust services. The manifests are designed for the `switchos` namespace and use in-cluster service DNS names. They are intentionally separated from external dependencies such as PostgreSQL, Keycloak/OIDC, Permify, OPA, Kafka, Redis, Temporal, Dapr, OpenSearch, TigerBeetle, Mojaloop, object storage, telephony, and ingress-controller infrastructure.

## Build images

Every image must be built from the repository revision being released, scanned, signed, pushed to the approved registry, and referenced by immutable digest or immutable version tag before applying any workload manifest.

```bash
# Central TypeScript application
docker build -t ghcr.io/munisp/deliveryplatform-central-app:IMMUTABLE_TAG .

# Go services
for service in inventory-control local-commerce-gateway mojaloop notification-dispatcher vertical-provisioning voice-gateway; do
  docker build -f services/go/Dockerfile \
    --build-arg SERVICE="$service" \
    -t "ghcr.io/munisp/deliveryplatform-${service}:IMMUTABLE_TAG" \
    services/go
done

# Python services
for service in intake-orchestrator lakehouse procurement-planner retail-forecast speech-runtime; do
  docker build -f services/python/Dockerfile \
    --build-arg SERVICE="$service" \
    -t "ghcr.io/munisp/deliveryplatform-${service}:IMMUTABLE_TAG" \
    services/python
done

# Rust services and schema migration image
# See pricing-dispatch/README.md for the remaining image commands.
```

## Secret and configuration delivery

Do **not** apply any `*.template.yaml` file. They describe required secret names and keys only. Create the following Secrets through the cluster's approved secret-manager integration:

| Secret | Consumers | Core keys |
|---|---|---|
| `switchos-runtime-secrets` | Pricing and dispatch | `DATABASE_URL`, `INTERNAL_SERVICE_TOKEN` |
| `central-app-secrets` | Central TypeScript application | Database, JWT, OIDC, policy, APISIX, OpenSearch, bootstrap credential, and optional Forge keys |
| `go-services-secrets` | Every Go service | Database, internal token, TigerBeetle mapping, Mojaloop/provider credentials |
| `python-services-secrets` | Every Python service | Database and internal token |

Set every public hostname and origin in the runtime ConfigMaps before rollout. Replace all image placeholders with immutable tags or digests. Create and populate the `speech-runtime-models` PVC with verified Piper and Whisper assets before enabling `speech-runtime`; its readiness must be validated with actual model assets, not only an HTTP process probe.

## Ordered deployment sequence

1. Provision and validate the external dependency platform, TLS, namespaces, DNS, secret-manager integration, container registry access, Dapr components, and storage classes.
2. Apply `pricing-dispatch/runtime-config.yaml`, create every environment-specific Secret, and run `pricing-dispatch/migration-job.yaml`. Wait for `deliveryplatform-schema-migration` to complete successfully. The Job applies every ordered `drizzle/*.sql` schema migration and never runs local seed data.
3. Substitute immutable image references and environment hostnames. Apply the top-level kustomization.
4. Wait for every Deployment rollout, verify `/health` and `/api/health` through cluster services, then validate authenticated and unauthorized flows over the ingress.
5. Run the cross-language integration suite against a non-production database and complete staged canary, rollback, backup/restore, eventing, payments, voice, and provider certification checks.

## Resilience design and validation

Every service Deployment has two or more replicas, HTTP startup/readiness/liveness probes, a PDB, HPA, resource requests/limits, and node placement protections. Go, Python, pricing, and dispatch services use a strict `topologySpreadConstraint` across at least two hostnames. The central app uses preferred pod anti-affinity because its HPA minimum is three replicas and it must be able to reconcile onto the two surviving nodes after a one-of-three-node failure.

Run the repository checks before cluster deployment:

```bash
python3 scripts/testing/validate-kubernetes-manifests.py
python3 scripts/testing/simulate-kubernetes-node-failure.py
```

The simulation is manifest-derived and tests each of three node-loss scenarios across all 14 Deployments at a simulated **150% CPU utilization**. It verifies immediate PDB availability, no additional voluntary eviction after an affected-node loss, schedulable recovery, and reconciliation to the HPA CPU-derived target. It does **not** replace a real staging-cluster chaos test. Before production approval, execute a controlled node drain or node termination in staging and collect actual controller, scheduler, PDB, HPA, readiness, and service-availability evidence.
