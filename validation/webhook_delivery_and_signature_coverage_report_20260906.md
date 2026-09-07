# Webhook Delivery and Signature Verification: Local Test Log and Coverage Report

**Date:** 2026-09-06
**Scope:** `tests/developer-webhook-delivery.test.ts` and `tests/medusa-commerce-signature.test.ts`
**Execution environment:** Local isolated Node/Vitest runner with a loopback-only HTTP receiver. No Medusa container, staging service, external DNS, certificate, cloud credential, API key, or production data was used.

## Executed command

```bash
pnpm vitest run \
  --coverage \
  --coverage.provider=v8 \
  --coverage.reportsDirectory=validation/webhook_coverage_20260906 \
  --reporter=verbose \
  tests/developer-webhook-delivery.test.ts \
  tests/medusa-commerce-signature.test.ts
```

## Detailed result

```text
RUN  v2.1.9 /home/ubuntu/DeliveryPlatform-commerce-field

✓ tests/developer-webhook-delivery.test.ts (3)
  ✓ developer webhook delivery dispatcher > delivers a signed event and durably records a successful completion
  ✓ developer webhook delivery dispatcher > records a retriable delivery outcome when an endpoint rejects the signed event
  ✓ developer webhook delivery dispatcher > classifies a loopback connection reset as a retriable transport failure

✓ tests/medusa-commerce-signature.test.ts (2)
  ✓ Medusa commerce event signatures > accepts a matching SHA-256 signature with or without its conventional prefix
  ✓ Medusa commerce event signatures > rejects malformed, mismatched, and replay-altered raw bodies

Test Files  2 passed (2)
     Tests  5 passed (5)
  Duration  0.59s
```

## Coverage summary

Vitest V8 coverage was collected across the project because the repository configuration does not restrict coverage to test targets. The relevant application modules are shown below; non-target project files with 0% coverage are not evidence of a failure in this focused suite.

| Module | Statements | Branches | Functions | Lines | Covered behavior and deliberate exclusions |
|---|---:|---:|---:|---:|---|
| `server/_core/developerWebhookDispatcher.ts` | **84.66%** | **50.00%** | **83.33%** | **84.66%** | Covers enabled dispatch, outbox publish, delivery claim, retry-stable persisted timestamp, canonical outbound body, HMAC-SHA-256 header, HTTP 204 success, HTTP 503 retry classification, loopback connection-reset classification, and token-bound durable completion. Uncovered paths are disabled/in-flight exit, absent secret, and selected configuration branches. |
| `server/_core/medusaCommerce.ts` | **17.64%** | **83.33%** | **25.00%** | **17.64%** | Covers the exported signature verifier’s valid, malformed, mismatched, and changed-body paths. It deliberately does not cover the database-backed HTTP ingress/persistence path because this test does not start a Medusa service or a database. |
| `server/_core/env.ts` | **79.37%** | **25.49%** | **100.00%** | **79.37%** | Loaded to configure the simulated dispatcher. The many production environment branching paths are outside this focused test. |

## Verified behavioral evidence

| Case | Result | Assertion |
|---|---|---|
| Successful developer webhook | Pass | The loopback receiver observed `X-Delivery-Id`, `X-Event-Id`, and `X-Webhook-Signature-256`; the received signature equaled an independently recomputed HMAC-SHA-256 of the exact request body. The simulated database completion call received `(delivery_id, claim_token, true, 204, null)`. |
| Retriable developer webhook failure | Pass | A loopback HTTP 503 received a correctly shaped signature and produced `(delivery_id, claim_token, false, 503, "endpoint_http_503")` at the durable completion boundary. |
| Loopback transport failure | Pass | A `127.0.0.1` receiver forcibly reset the connection. The dispatcher classified it as `(delivery_id, claim_token, false, 599, "TypeError")`, which the durable scheduler treats as retriable. |
| Medusa event signature | Pass | A valid HMAC signature was accepted. Malformed, mismatched, and body-altered raw-body signatures were rejected. |

## Supporting artifacts

The complete unabridged command output is retained in `validation/webhook_delivery_and_signature_test_log_20260906.txt`. V8 report files are under `validation/webhook_coverage_20260906/`.

> This focused coverage report does not replace the disposable PostgreSQL/PostGIS developer API harness, staging delivery test, target-side replay testing, TLS verification, secret-manager integration, or multi-worker concurrency evidence.
