# Circuit-Breaker Receiver: Build, Sign, Deploy, and Local Kind Verification

## Staging image pipeline

Build from `services/go/resilience-circuit-breaker-alert-receiver` only. The Dockerfile uses a pinned builder image and a non-root distroless runtime. The CI workflow must obtain registry access using short-lived workload identity, not a long-lived registry password.

```bash
export IMAGE_REPOSITORY=registry.example.invalid/deliveryplatform/resilience-circuit-breaker-alert-receiver
export IMAGE_TAG="${GITHUB_SHA}"
docker build --pull --no-cache -t "${IMAGE_REPOSITORY}:${IMAGE_TAG}" services/go/resilience-circuit-breaker-alert-receiver
docker push "${IMAGE_REPOSITORY}:${IMAGE_TAG}"
DIGEST="$(docker buildx imagetools inspect "${IMAGE_REPOSITORY}:${IMAGE_TAG}" --format '{{json .Manifest.Digest}}' | tr -d '"')"
```

CI must generate and archive an SBOM and provenance attestation, scan the digest, sign the digest with the organisation’s short-lived signing identity, and verify the signature before deployment. The deployment manifest must replace `REPLACE_WITH_IMMUTABLE_RECEIVER_DIGEST` with `${IMAGE_REPOSITORY}@${DIGEST}`; tags are not deployment identifiers.

```bash
cosign attest --yes --predicate sbom.spdx.json --type spdx "${IMAGE_REPOSITORY}@${DIGEST}"
cosign sign --yes "${IMAGE_REPOSITORY}@${DIGEST}"
cosign verify --certificate-identity-regexp '^https://github.com/munisp/DeliveryPlatform/' --certificate-oidc-issuer https://token.actions.githubusercontent.com "${IMAGE_REPOSITORY}@${DIGEST}"
```

Before applying manifests, create two different secret resources through the approved secret controller: `resilience-circuit-breaker-alert-receiver` in `resilience-test` for the receiver token, and `resilience-circuit-breaker-alert-receiver-auth` in `monitoring` for Alertmanager’s same token. Provision the serving certificate Secret and CA ConfigMap through the approved certificate controller. Never use literals in Git.

## Local kind verification

Use a disposable cluster and namespace only.

```bash
kind create cluster --name resilience-receiver --wait 60s
kubectl create namespace resilience-test
kubectl label namespace resilience-test resilience.delivery-platform.io/environment=non-production --overwrite
kubectl create namespace monitoring
kubectl apply -f deploy/kubernetes/resilience-test/circuit-breaker.yaml
kubectl apply -f deploy/kubernetes/resilience-test/circuit-breaker-alert-receiver.yaml
kubectl auth can-i --as=system:serviceaccount:resilience-test:resilience-circuit-breaker-alert-receiver patch configmap/resilience-validation-circuit-breaker -n resilience-test
kubectl auth can-i --as=system:serviceaccount:resilience-test:resilience-circuit-breaker-alert-receiver get secrets -n resilience-test
```

The first authorization must return `yes`; the second must return `no`. Create test-only token and TLS resources before starting the Deployment. Port-forward the TLS Service and send an authenticated synthetic Alertmanager webhook. The service must accept the allowlisted firing alert, change only `data.state` from `closed` to `open`, and preserve all unrelated resource data.

```json
{"status":"firing","alerts":[{"status":"firing","fingerprint":"kind-invariant-failed-001","labels":{"alertname":"ResilienceInvariantProbeFailed","severity":"critical","namespace":"resilience-test","circuit_breaker":"open","resilience.delivery-platform.io/environment":"non-production"}}]}
```

```bash
kubectl -n resilience-test get configmap resilience-validation-circuit-breaker -o jsonpath='{.data.state}{"\n"}'
kubectl -n resilience-test port-forward service/resilience-circuit-breaker-alert-receiver 8443:8443
curl --fail --cacert receiver-ca.crt --header "Authorization: Bearer ${ALERTMANAGER_WEBHOOK_TOKEN}" --header 'Content-Type: application/json' --data @allowed-alert.json https://127.0.0.1:8443/v1/alertmanager/open
kubectl -n resilience-test get configmap resilience-validation-circuit-breaker -o jsonpath='{.data.state}{" "}{.data.incident_id}{" "}{.data.opened_by}{"\n"}'
```

Then prove rejection and idempotency: omit authentication (401); send `severity=warning` (403); use a foreign namespace (403); use `status=resolved` (400); repeat the allowed payload (202 without changing original opening data); and confirm no close endpoint exists. Finally delete the cluster.

```bash
kind delete cluster --name resilience-receiver
```
