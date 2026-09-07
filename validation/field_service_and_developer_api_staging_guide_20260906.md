# Field Services and Developer API: Independent Verification and Secure Staging Configuration

**Branch:** `feature/commerce-field-developer`
**Scope:** Field Services and the public Developer API only. The Medusa container is deliberately absent from this deployment.
**Execution status:** The commands and manifests below are configuration instructions only. They have not been applied to any cluster.

## 1. Independent local verification evidence

The following commands were rerun on 2026-09-06 against fresh disposable local PostgreSQL/PostGIS databases. Neither test starts, connects to, or requires the Medusa service/container.

| Verification | Command | Result | Evidence exercised |
|---|---|---|---|
| Field-service database harness | `./scripts/testing/validate-field-service-db.sh` | **PASS** | Service-area assignment, idempotent create, schedule, assignment, en-route, on-site, three proof writes, completion, idempotent completion, immutable events/outbox, and least-privilege function boundaries. Final lifecycle: `completed\|8\|3\|8`. |
| Developer API database harness | `./scripts/testing/validate-developer-api-db.sh` | **PASS** | Hashed/scoped key authentication, provider isolation, idempotent public request handling, public collection authorization, webhook registration, field-service outbox publication, transactional delivery claim/completion, immutable delivery evidence, and restricted function execution. |
| TypeScript contract integration | `pnpm run check` | **PASS** | Public routes, OpenAPI contract, field-service adapter/router, developer service, dispatcher configuration, and UI type integration. |
| Signed commerce ingress unit test | `pnpm vitest run tests/medusa-commerce-signature.test.ts` | **PASS: 1 file, 2 tests** | Valid HMAC acceptance; malformed, mismatched, and altered-body rejection. This is a pure local boundary test, not a Medusa deployment test. |

> The local Field Services and Developer API result is independent of Medusa. It does not establish staging reachability, ingress enforcement, real identity integration, notification delivery, or a production release.

## 2. Deployment topology and hard boundary

Deploy the same approved DeliveryPlatform application image with a **public developer-api runtime database role** that inherits only `developer_api_service`. Expose only the four public paths through the staging gateway:

| Method | Exposed path | Required API-key scope |
|---|---|---|
| `GET` | `/api/v1/openapi.json` | None |
| `GET` | `/api/v1/field-service/work-orders` | `field_service:read` |
| `POST` | `/api/v1/field-service/work-orders` | `field_service:write` and `Idempotency-Key` |
| `GET` | `/api/v1/field-service/work-orders/{id}` | `field_service:read` |
| `GET` | `/api/health` | Gateway/probe only; do not publish it to the Internet |

The public deployment **must set** `ENABLE_MEDUSA_EVENT_INGRESS=false` and **must not** include `MEDUSA_STORE_WEBHOOK_SECRETS_JSON`. It also begins with `ENABLE_DEVELOPER_WEBHOOK_DISPATCH=false`; webhook delivery is enabled only in a separately reviewed worker deployment with a restricted destination allow-list and secret-reference mapping.

The source currently runs a unified Express application. The public ingress path restriction and the `developer_api_service` database role are therefore complementary controls: no operator/tRPC path is public, and the public process cannot invoke management, technician, or commerce-only database functions.

## 3. Staging preconditions

The staging cluster must have a NetworkPolicy-enforcing CNI. Kubernetes states that NetworkPolicy resources have no effect when the installed network plugin does not enforce them.[1] Apply the namespace default-deny rules before creating the Deployment, then add only the required allow rules. Kubernetes also notes that a deny-all egress policy blocks DNS unless DNS is explicitly allowed.[1]

Prepare these non-production values through the organization’s approved secret manager. Do not put any value in Git, YAML `stringData`, shell history, browser automation, or chat:

| Secret key | Required use |
|---|---|
| `DATABASE_URL` | PostgreSQL connection for the `developer_api_public_staging_runtime` login; use `sslmode=verify-full`. |
| `DATABASE_SSL_CA` | PEM CA bundle when PostgreSQL uses a private CA. |
| `JWT_SECRET` | A random, rotated session-signing secret required by production-mode validation. |
| `INTERNAL_SERVICE_TOKEN` | Random internal-only token required by production-mode validation; never accept it at the public gateway. |
| `BOOTSTRAP_OPERATOR_PASSWORD` | Random staging-only bootstrap password required by production-mode validation; do not use it for public API authentication. |
| `OAUTH_SERVER_URL` | Internal OAuth URL required by production-mode validation. |
| `PERMIFY_ENDPOINT`, `PERMIFY_AUTH_TOKEN` | Internal authorization endpoint and secret required by production-mode validation. |
| `OPA_ENDPOINT`, `OPA_AUTH_TOKEN` | Internal policy endpoint and secret required by production-mode validation. |

Use a digest-pinned image that was built from the reviewed branch and passed `pnpm run check`, `pnpm run build`, `./scripts/testing/validate-field-service-db.sh`, and `./scripts/testing/validate-developer-api-db.sh`. Do not use a mutable tag such as `latest`.

## 4. Apply the ordered database migration chain with separate identities

Use a migration-only database login for DDL, never the public runtime login. Run against the dedicated non-production PostgreSQL/PostGIS database, with TLS enabled, after a backup/snapshot and maintenance approval. Do **not** run fixture-writing harnesses against shared staging.

```bash
export DDL_DATABASE_URL='postgresql://migration_identity@staging-postgres.example:5432/deliveryplatform_staging?sslmode=verify-full'
export PGSSLMODE=verify-full
export PGSSLROOTCERT=/secure/ca/postgres-ca.pem

cd /secure/reviewed/DeliveryPlatform
for migration in \
  drizzle/0044_field_service_operations.sql \
  drizzle/0045_developer_api_platform.sql \
  drizzle/0046_medusa_commerce_fulfillment.sql \
  drizzle/0047_field_service_proof_and_public_collection.sql; do
  psql "$DDL_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$migration"
done
```

After migrations finish, create a distinct runtime login. The role names below are capability roles created by the migrations; the public runtime receives only the developer public-API capability, no table grants, no DDL, and no role-administration privileges.

```sql
-- Run as the approved staging database administrator. Obtain the password through
-- a protected file descriptor or managed-secret injection, not an inline command.
CREATE ROLE developer_api_public_staging_runtime
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;

GRANT developer_api_service TO developer_api_public_staging_runtime;

ALTER ROLE developer_api_public_staging_runtime
  SET statement_timeout = '5s';
ALTER ROLE developer_api_public_staging_runtime
  SET lock_timeout = '2s';
ALTER ROLE developer_api_public_staging_runtime
  SET idle_in_transaction_session_timeout = '15s';

REVOKE ALL ON ALL TABLES IN SCHEMA field_service, developer, commerce
  FROM developer_api_public_staging_runtime;
REVOKE CREATE ON SCHEMA public FROM developer_api_public_staging_runtime;
```

Verify the effective role before deploying:

```sql
BEGIN READ ONLY;
SELECT current_user, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin
FROM pg_roles WHERE rolname = current_user;

SELECT has_schema_privilege(current_user, 'developer', 'USAGE') AS developer_schema_usage,
       has_table_privilege(current_user, 'developer.api_key', 'SELECT') AS direct_api_key_table_select,
       has_table_privilege(current_user, 'field_service.work_order', 'SELECT') AS direct_work_order_table_select;

SELECT has_function_privilege(
  current_user,
  'developer.authenticate_api_key(text,bytea,text,timestamp with time zone)',
  'EXECUTE'
) AS can_authenticate_api_key;
ROLLBACK;
```

The expected result is a non-superuser login with `developer_schema_usage=true`, both direct-table checks `false`, and function execution `true`.

## 5. Cloud-agnostic secret delivery

Create a Kubernetes Secret through an approved external-secret controller or an audited, one-time `kubectl create secret` procedure. The manifest itself deliberately does not contain secret values.

```bash
kubectl -n deliveryplatform-staging create secret generic developer-api-runtime-secrets \
  --from-literal=DATABASE_URL="$(cat /secure/staging/DATABASE_URL)" \
  --from-file=DATABASE_SSL_CA=/secure/staging/postgres-ca.pem \
  --from-literal=JWT_SECRET="$(cat /secure/staging/JWT_SECRET)" \
  --from-literal=INTERNAL_SERVICE_TOKEN="$(cat /secure/staging/INTERNAL_SERVICE_TOKEN)" \
  --from-literal=BOOTSTRAP_OPERATOR_PASSWORD="$(cat /secure/staging/BOOTSTRAP_OPERATOR_PASSWORD)" \
  --from-literal=OAUTH_SERVER_URL="$(cat /secure/staging/OAUTH_SERVER_URL)" \
  --from-literal=PERMIFY_ENDPOINT="$(cat /secure/staging/PERMIFY_ENDPOINT)" \
  --from-literal=PERMIFY_AUTH_TOKEN="$(cat /secure/staging/PERMIFY_AUTH_TOKEN)" \
  --from-literal=OPA_ENDPOINT="$(cat /secure/staging/OPA_ENDPOINT)" \
  --from-literal=OPA_AUTH_TOKEN="$(cat /secure/staging/OPA_AUTH_TOKEN)"
```

Use a secret-manager integration in the real environment so the shown command is a break-glass option only. Restrict the deployment service account to **no Kubernetes API permissions** and set `automountServiceAccountToken: false`.

## 6. Medusa-decoupled staging manifest

Save the following as `developer-api-staging.yaml` only after replacing the domain, image digest, database CIDR, and internal service labels with values from the intended cluster. The `<...>` values are required deployment inputs, not safe defaults.

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: deliveryplatform-staging
  labels:
    environment: staging
    network-zone: deliveryplatform-staging
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: developer-api-staging
  namespace: deliveryplatform-staging
automountServiceAccountToken: false
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: developer-api-staging-config
  namespace: deliveryplatform-staging
data:
  NODE_ENV: production
  PORT: "3005"
  BIND_HOST: "0.0.0.0"
  VITE_APP_ID: switchos-developer-api-staging
  PUBLIC_APP_ORIGIN: https://developer-api.staging.<YOUR_DOMAIN>
  ALLOWED_ORIGINS: https://developer-api.staging.<YOUR_DOMAIN>
  API_BODY_LIMIT: 1mb
  ENABLE_SELF_SERVICE_SIGNUP: "false"
  REQUIRE_MFA_FOR_PRIVILEGED_ACTIONS: "true"
  ENABLE_EXTERNAL_OIDC: "false"
  ENABLE_DEVELOPER_WEBHOOK_DISPATCH: "false"
  ENABLE_MEDUSA_EVENT_INGRESS: "false"
  SESSION_ISSUER: deliveryplatform-staging
  SESSION_AUDIENCE: developer-api-staging
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: developer-api-staging
  namespace: deliveryplatform-staging
  labels:
    app.kubernetes.io/name: developer-api
    app.kubernetes.io/component: public-api
    app.kubernetes.io/part-of: deliveryplatform
    environment: staging
spec:
  replicas: 2
  revisionHistoryLimit: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: developer-api
      app.kubernetes.io/component: public-api
  template:
    metadata:
      labels:
        app.kubernetes.io/name: developer-api
        app.kubernetes.io/component: public-api
        app.kubernetes.io/part-of: deliveryplatform
        environment: staging
    spec:
      serviceAccountName: developer-api-staging
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: developer-api
          image: <APPROVED_REGISTRY>/deliveryplatform@sha256:<REVIEWED_IMAGE_DIGEST>
          imagePullPolicy: IfNotPresent
          command: ["node", "dist/index.js"]
          ports:
            - name: http
              containerPort: 3005
          envFrom:
            - configMapRef:
                name: developer-api-staging-config
          env:
            - name: DATABASE_URL
              valueFrom: { secretKeyRef: { name: developer-api-runtime-secrets, key: DATABASE_URL } }
            - name: DATABASE_SSL_CA
              valueFrom: { secretKeyRef: { name: developer-api-runtime-secrets, key: DATABASE_SSL_CA } }
            - name: JWT_SECRET
              valueFrom: { secretKeyRef: { name: developer-api-runtime-secrets, key: JWT_SECRET } }
            - name: INTERNAL_SERVICE_TOKEN
              valueFrom: { secretKeyRef: { name: developer-api-runtime-secrets, key: INTERNAL_SERVICE_TOKEN } }
            - name: BOOTSTRAP_OPERATOR_PASSWORD
              valueFrom: { secretKeyRef: { name: developer-api-runtime-secrets, key: BOOTSTRAP_OPERATOR_PASSWORD } }
            - name: OAUTH_SERVER_URL
              valueFrom: { secretKeyRef: { name: developer-api-runtime-secrets, key: OAUTH_SERVER_URL } }
            - name: PERMIFY_ENDPOINT
              valueFrom: { secretKeyRef: { name: developer-api-runtime-secrets, key: PERMIFY_ENDPOINT } }
            - name: PERMIFY_AUTH_TOKEN
              valueFrom: { secretKeyRef: { name: developer-api-runtime-secrets, key: PERMIFY_AUTH_TOKEN } }
            - name: OPA_ENDPOINT
              valueFrom: { secretKeyRef: { name: developer-api-runtime-secrets, key: OPA_ENDPOINT } }
            - name: OPA_AUTH_TOKEN
              valueFrom: { secretKeyRef: { name: developer-api-runtime-secrets, key: OPA_AUTH_TOKEN } }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: tmp
              mountPath: /tmp
          startupProbe:
            httpGet: { path: /api/health, port: http }
            periodSeconds: 5
            failureThreshold: 24
            timeoutSeconds: 2
          readinessProbe:
            httpGet: { path: /api/health, port: http }
            periodSeconds: 10
            failureThreshold: 3
            timeoutSeconds: 2
          livenessProbe:
            httpGet: { path: /api/health, port: http }
            periodSeconds: 20
            failureThreshold: 3
            timeoutSeconds: 2
          resources:
            requests: { cpu: 250m, memory: 512Mi }
            limits: { cpu: "1", memory: 1Gi }
      volumes:
        - name: tmp
          emptyDir:
            sizeLimit: 64Mi
---
apiVersion: v1
kind: Service
metadata:
  name: developer-api-staging
  namespace: deliveryplatform-staging
spec:
  selector:
    app.kubernetes.io/name: developer-api
    app.kubernetes.io/component: public-api
  ports:
    - name: http
      port: 80
      targetPort: http
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: deliveryplatform-staging
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: developer-api-allow-required-traffic
  namespace: deliveryplatform-staging
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: developer-api
      app.kubernetes.io/component: public-api
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
          podSelector:
            matchLabels:
              app.kubernetes.io/name: ingress-nginx
      ports:
        - protocol: TCP
          port: 3005
  egress:
    # Cluster DNS. Confirm labels and port in the actual cluster.
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    # Dedicated PostgreSQL/Stunnel CIDR only. Replace before apply.
    - to:
        - ipBlock: { cidr: <STAGING_POSTGRES_OR_TUNNEL_CIDR> }
      ports:
        - protocol: TCP
          port: 5432
    # Internal policy and authorization services. Replace labels/ports with cluster inventory.
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: identity
          podSelector:
            matchLabels:
              app.kubernetes.io/name: permify
      ports:
        - protocol: TCP
          port: <PERMIFY_PORT>
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: policy
          podSelector:
            matchLabels:
              app.kubernetes.io/name: opa
      ports:
        - protocol: TCP
          port: <OPA_PORT>
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: developer-api-staging
  namespace: deliveryplatform-staging
  annotations:
    # Configure TLS, request-size limits, WAF, and rate limits in the installed
    # gateway/ingress controller policy; do not assume controller-specific annotations.
spec:
  ingressClassName: <APPROVED_INGRESS_CLASS>
  tls:
    - hosts: [developer-api.staging.<YOUR_DOMAIN>]
      secretName: developer-api-staging-tls
  rules:
    - host: developer-api.staging.<YOUR_DOMAIN>
      http:
        paths:
          - path: /api/v1
            pathType: Prefix
            backend:
              service: { name: developer-api-staging, port: { name: http } }
```

The public `Ingress` intentionally omits `/api/health`; probes reach the pod directly. Configure the approved gateway to require TLS, reject bodies above 1 MiB, preserve `X-Request-Id`, enforce an API-specific rate policy, permit only `GET`/`POST` as appropriate, and never inject internal-service headers from untrusted clients.

Kubernetes readiness probes prevent an unready pod from receiving Service traffic; startup probes protect a slow initialization window before liveness handling begins.[2] The restrictive security context uses `runAsNonRoot`, dropped capabilities, `allowPrivilegeEscalation: false`, `RuntimeDefault` seccomp, and a read-only root filesystem, which are supported container security controls.[3]

## 7. Apply and verify without Medusa

After a cluster administrator has verified the CNI, domain, ingress class, image digest, required labels, and database CIDR, apply and observe:

```bash
kubectl apply --server-side --dry-run=server -f developer-api-staging.yaml
kubectl apply -f developer-api-staging.yaml

kubectl -n deliveryplatform-staging rollout status deployment/developer-api-staging --timeout=180s
kubectl -n deliveryplatform-staging get pods,svc,ingress,networkpolicy
kubectl -n deliveryplatform-staging describe deployment developer-api-staging
kubectl -n deliveryplatform-staging logs deployment/developer-api-staging --tail=200
```

Provision a short-lived, provider-scoped staging API key using the authenticated Developer Platform console; the raw `dpk_...` value is shown only once. Put it in a secret-backed test job or export it only in an ephemeral shell, never in a manifest, CI log, or ticket.

```bash
export DEVELOPER_API_BASE_URL='https://developer-api.staging.<YOUR_DOMAIN>'
export STAGING_DEVELOPER_API_KEY="$(cat /secure/staging/developer_api_smoke_key)"

curl --fail-with-body --silent --show-error \
  "$DEVELOPER_API_BASE_URL/api/v1/openapi.json" | jq '.openapi, .info.version'

curl --fail-with-body --silent --show-error \
  -H "X-API-Key: $STAGING_DEVELOPER_API_KEY" \
  "$DEVELOPER_API_BASE_URL/api/v1/field-service/work-orders?limit=1"

idempotency_key="staging-$(date +%s)-field-service-create"
curl --fail-with-body --silent --show-error \
  -X POST "$DEVELOPER_API_BASE_URL/api/v1/field-service/work-orders" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $STAGING_DEVELOPER_API_KEY" \
  -H "Idempotency-Key: $idempotency_key" \
  --data @/secure/staging/field-service-work-order-smoke.json

# Replay exactly the same request: it must return the original idempotent result,
# not create another work order.
curl --fail-with-body --silent --show-error \
  -X POST "$DEVELOPER_API_BASE_URL/api/v1/field-service/work-orders" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $STAGING_DEVELOPER_API_KEY" \
  -H "Idempotency-Key: $idempotency_key" \
  --data @/secure/staging/field-service-work-order-smoke.json
```

Use a provider-scoped, synthetic staging location and customer reference only. Confirm that a different provider’s key receives `404` or the appropriate authorization failure for the created work order. Do not use a real technician, customer, proof object, payment instrument, or Medusa store.

## 8. Staging acceptance criteria

The decoupled API staging step is acceptable only when all of the following are evidenced against the applied revision: the image digest matches the reviewed commit; every pod is Ready; the public route exposes only `/api/v1`; `ENABLE_MEDUSA_EVENT_INGRESS=false`; `ENABLE_DEVELOPER_WEBHOOK_DISPATCH=false`; runtime-role catalog checks show no direct table access; the OpenAPI document is reachable; positive API-key, missing-key, insufficient-scope, cross-provider, malformed-payload, and idempotent-replay tests produce expected responses; the database contains one append-only lifecycle event sequence; and ingress/network-policy tests show disallowed paths and disallowed egress cannot connect.

This staging configuration does not verify real identity federation, object storage, webhook delivery, mobile technician devices, customer communications, payment/tax, maps, emergency support, regulation, or a Medusa deployment. Those are intentionally outside this Medusa-decoupled developer API release gate.

## References

[1] [Kubernetes: Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
[2] [Kubernetes: Configure Liveness, Readiness, and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
[3] [Kubernetes: Configure a Security Context for a Pod or Container](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)
