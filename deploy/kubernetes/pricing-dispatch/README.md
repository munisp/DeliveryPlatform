# Pricing and Dispatch Kubernetes Package

This package deploys the **Rust pricing engine** and **Rust dispatch optimizer** after the database schema is migrated. It is designed for a Kubernetes namespace named `switchos` and deliberately does **not** apply any placeholder secret.

## Build inputs

Build all images from the repository root with immutable version tags. The Rust service images use the service-specific Dockerfiles; the migration image packages the complete `drizzle/*.sql` chain and the PostgreSQL initializer.

```bash
docker build -f services/rust/pricing-engine/Dockerfile \
  -t ghcr.io/munisp/deliveryplatform-pricing-engine:IMMUTABLE_TAG \
  services/rust/pricing-engine

docker build -f services/rust/dispatch-optimizer/Dockerfile \
  -t ghcr.io/munisp/deliveryplatform-dispatch-optimizer:IMMUTABLE_TAG \
  services/rust/dispatch-optimizer

docker build -f deploy/kubernetes/pricing-dispatch/Dockerfile.migrations \
  -t ghcr.io/munisp/deliveryplatform-migrations:IMMUTABLE_TAG \
  .
```

Replace each `REPLACE_WITH_IMMUTABLE_TAG` image placeholder in `workloads.yaml` and `migration-job.yaml` before deployment. Do not deploy mutable tags such as `latest`.

## Required environment contract

| Variable | Kubernetes source | Requirement |
|---|---|---|
| `DATABASE_URL` | `switchos-runtime-secrets` | PostgreSQL TLS DSN for the target environment. A database role must have the privileges needed by the migration Job and runtime queries. |
| `INTERNAL_SERVICE_TOKEN` | `switchos-runtime-secrets` | Unique high-entropy secret of at least 32 characters. Never reuse the test token. |
| `BIND_HOST` | `pricing-dispatch-runtime-config` | `0.0.0.0` in Kubernetes. |
| `RUST_LOG` | `pricing-dispatch-runtime-config` | Structured application log level; default is `info`. |
| `DATABASE_POOL_MAX_SIZE` | `pricing-dispatch-runtime-config` | Maximum persistent PostgreSQL clients **per pod**. Default is 4. |

The default configuration has two minimum replicas per service and a pool size of four, for a base budget of 16 database connections across pricing and dispatch. At the configured HPA maximum of five replicas per service, the two services use at most 40 connections. Before increasing the HPA maximum or pool size, reserve connection capacity for PostgreSQL administration, migrations, other services, and failover. The runtime enforces a pool-size range from 4 to 48.

## Deployment sequence

1. Create the `switchos` namespace and provision `switchos-runtime-secrets` from the production secret manager. Use `runtime-secrets.template.yaml` only as a variable-name reference; it is not an apply-safe secret.
2. Build, sign, scan, publish, and substitute immutable image digests or tags.
3. Apply `runtime-config.yaml` and `migration-job.yaml`. Wait for `deliveryplatform-schema-migration` to complete successfully. The Job applies every lexicographically ordered `drizzle/*.sql` migration, including `0007a_operator_credentials.sql` and `0025_pricing_dispatch_performance.sql`. It intentionally does **not** run `scripts/init-local-postgres.sql`, because that local-development helper contains seed data that must never be inserted by a production migration Job.
4. Apply `kustomization.yaml` and wait until both deployment rollouts are available. Readiness checks execute `SELECT 1` through the bounded database pool; a loss of database connectivity marks a pod unready.
5. Exercise one unauthorized request and one authenticated request through the in-cluster service DNS names. Confirm that Kubernetes limits, HPA, PDB, NetworkPolicy, and telemetry are active.

## Package validation

The repository validates YAML document structure with:

```bash
python3 scripts/testing/validate-kubernetes-manifests.py
bash -n deploy/kubernetes/pricing-dispatch/apply-migrations.sh
```

A fresh PostgreSQL database was used to apply the complete migration sequence without local seed data. The validation created the tracked production schema and all seven pricing/dispatch performance indexes.

## Scope and remaining platform packaging work

This package is complete for the two analyzed Rust services and the shared PostgreSQL schema migration Job. It does **not** by itself make the full DeliveryPlatform Kubernetes-ready. The central TypeScript application, six Go services, five Python services, gateway/identity/policy dependencies, Kafka/Redis/Temporal/OpenSearch/TigerBeetle/Mojaloop, object storage, and public ingress require their own versioned images, workload manifests, secret mappings, resource budgets, network policies, and staged deployment validation before a full-platform Kubernetes release can be approved.
