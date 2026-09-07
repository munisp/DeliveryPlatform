# Local Developer Event Pipeline Simulation

**Date:** 2026-09-06
**Scope:** Isolated loopback webhook receiver, mocked disposable database boundary, and the real signature-verification modules.
**Not used:** Staging, production, Medusa container, external endpoint, real API key, real signing secret, or real customer data.

## Executed command

```bash
pnpm vitest run \
  tests/developer-webhook-delivery.test.ts \
  tests/medusa-commerce-signature.test.ts
```

## Result

```text
Test Files  2 passed (2)
     Tests  4 passed (4)
Duration    1.56s
```

The added `developer-webhook-delivery.test.ts` was then formatted and checked with:

```bash
pnpm exec prettier --check tests/developer-webhook-delivery.test.ts
pnpm run check
git diff --check
```

All three checks passed.

## Verified delivery behavior

| Test | Result | Verified behavior |
|---|---|---|
| Signed delivery, HTTP 204 | Pass | The dispatcher publishes and claims one delivery, sends the exact delivery/event identifiers, serializes the event envelope, computes `X-Webhook-Signature-256: sha256=<64 hex characters>` with HMAC-SHA-256 over the actual outbound body, and records success through the database completion function. |
| Rejected delivery, HTTP 503 | Pass | The dispatcher preserves the signed delivery attempt, classifies the result as retriable, and calls the durable completion function with `success=false`, status `503`, and `endpoint_http_503`. |
| Medusa event valid/malformed/mismatched signatures | Pass | The ingress verifier accepts a valid signature and rejects malformed, mismatched, or body-altered signatures. |

## Evidence boundary

This simulation verifies the application's signing, HTTP result classification, and durable database-call interface. The mocked database does not replace the previously passed disposable PostgreSQL/PostGIS developer API harness, which validates the real publisher, claim, completion, append-only evidence, and least-privilege database functions. This simulation is not evidence of external webhook reachability, DNS/TLS policy, secret-manager retrieval, concurrent workers, target-side replay protection, or staging deployment.
