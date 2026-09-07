# Database Authority and External-Simulation Readiness Review

**Author:** Manus AI
**Date:** 2026-09-07
**Scope:** DeliveryPlatform clean-room vehicle-access, dispatch-fairness, economics, webhook, payment, commerce, and defined integration boundaries in the isolated worktree.

## Exact Economics Validator Output and Assertions

The script `scripts/testing/validate-driver-offer-economics-db.sh` creates a unique local PostgreSQL/PostGIS database named `driver_offer_economics_validation_<pid>_<epoch>`, runs `0026`, `0051`, and `0052`, and deletes the database in its `EXIT` trap. It does not read a target connection URL.

The first successful allocation asserts the exact state below:

```sql
IF v_floor <> 16848 OR v_subsidy <> 1008 OR v_base <> 15840
   OR v_net <> 16848 OR v_contribution <> 652 THEN
  RAISE EXCEPTION 'dynamic economics calculation mismatch floor=% subsidy=% base=% net=% contribution=%',
    v_floor,v_subsidy,v_base,v_net,v_contribution;
END IF;
```

Its two independent fail-closed checks are:

```sql
-- Fuel-indexed driver-floor breach: must not issue an offer.
SELECT * FROM mobility.create_transparent_driver_offer(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '99999999-9999-4999-8999-999999999999',
  '88888888-8888-4888-8888-888888888888',
  2,1::smallint,0.5::numeric,'{}'::jsonb,
  timestamptz '2026-09-07 08:06:00+00',500,120,70,
  timestamptz '2026-09-07 08:02:01+00'
);

-- Contribution-target breach: must not issue an offer.
SELECT * FROM mobility.create_transparent_driver_offer(
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  2,1::smallint,0.5::numeric,'{}'::jsonb,
  timestamptz '2026-09-07 08:07:00+00',500,120,70,
  timestamptz '2026-09-07 08:03:01+00'
);
```

The terminal assertions reject any persisted offer with either test ID:

```bash
SELECT count(*) FROM mobility.driver_offer
WHERE id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

SELECT count(*) FROM mobility.driver_offer
WHERE id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
```

The final local execution produced `driver_earnings_floor_unmet` and `platform_contribution_target_unmet`, followed by `driver_offer_economics_result=PASS`.

## Is a Database-Authoritative Design the Correct Approach?

For this platform’s **safety-critical, financial, allocation, and lifecycle invariants**, PostgreSQL authority is appropriate. A driver offer must not be double-reserved; a fare/commission/economics disclosure must remain immutable after acceptance; a payment callback must not create duplicate ledger effects; a delivery worker must not overwrite a newer webhook claim; and a vehicle should not be allocated to overlapping active contracts. Those are transactionally coupled state transitions, which relational constraints, row locks, append-only events, and security-definer transition functions can enforce even if an API handler, worker, cache, or client is faulty.

The database must not become a catch-all computation engine. The correct division is summarized below.

| Responsibility | PostgreSQL authority | Application or worker responsibility | External boundary responsibility |
|---|---|---|---|
| Money, trip/offer/contract states, authorization predicates, policy versions, idempotency, audit records | Enforce constraints, lock/transition, persist facts | Supply authenticated intent and handle approved results | Verify provider evidence before it can affect durable state |
| Dispatch candidate discovery and route/ETA scoring | Preserve final reservation and safety/economics gates | Compute/rank candidates, batch work, cache short-lived reads | Supply route/traffic/geocode data under a verified contract |
| Dynamic floor/subsidy | Derive snapshot from approved versioned policy and fail closed | Fetch/show disclosure, publish only bounded operator input | Supply approved fuel/cost benchmarks; never mutate offer state directly |
| Webhook delivery | Own claim leases, tokens, retry schedule, terminal state | Send HTTP and report success/failure | Authenticate recipient and deduplicate `X-Delivery-Id` |
| Analytics and reporting | Hold event facts | Read/project asynchronously | Optional warehouse/search systems are non-authoritative |

This design avoids cache or external-provider authority over money and allocation. It also has costs: transaction functions must remain small, indexed, deterministic, and fully tested; slow HTTP, route calls, large scoring loops, ML, and long batch work must remain outside transactions. Current matching uses the Go worker for candidate selection and the database for final offer reservation, which follows this split. High-volume deployment should measure query plans, lock waits, function latency, index bloat, autovacuum lag, and connection-pool saturation before scaling worker concurrency.

## Implemented External-Boundary Simulations

`run-defined-external-boundary-simulations.sh` executes only local loopback services and disposable databases. Its most recent execution passed the following defined contracts.

| Contract class | Real production code exercised locally | Result |
|---|---|---|
| HTTP discovery and health | OIDC discovery, APISIX, OpenAppSec, Permify, Dapr, Fluvio, OpenSearch, and service health probes | Passed against loopback contracts |
| Dispatch/procurement/inventory | Newly added `probeDispatchOptimizer`, `probeProcurementPlanner`, and `probeInventoryControl` included in live integration status | Passed against loopback `/health` contracts |
| Outbound developer webhook | HMAC signing, loopback connection-reset classification, token fencing, durable retry/jitter/dead letter | Passed against loopback/disposable database |
| Medusa ingress | Raw-body HMAC verifier and delivery-execution database lifecycle | Passed locally |
| Payment/funds | Existing Go financial-message and settlement contract tests | Passed locally |
| Destination/economics | Actual Go matching worker, local Redis, PostgreSQL, synthetic provider-versioned destination/fare inputs | Passed one issued transparent offer and one fail-closed high-index case |

The consolidated runner finished with `defined_external_boundary_simulations=PASS`. The application suite subsequently passed 46 test files / 224 tests with 30 intentional skips, TypeScript validation, production build, formatting, shell syntax, and diff integrity.

## What Cannot Be Truthfully Simulated as a Generic Destination

A regulation, operating licence, insurance/product term, tax position, carrier agreement, KYC/identity decision, payment-provider certification, price-feed licence, real-world vehicle inspection, and customer consent are not universal HTTP APIs. The codebase does not have provider-specific contracts, credentials, or approved test tenants for them. A local fake response cannot certify that a provider, regulator, or insurer will accept production data.

For every newly selected provider, a production-bound adapter must be implemented from that provider’s current sandbox contract, with secrets held by the target secret system, signature verification, request/response schema validation, idempotency, bounded timeouts, retry classification, structured non-secret logging, an outbox/inbox record, and a local/contract test fixture. Its sandbox test evidence must be approved by the provider and the relevant responsible business owner before production enablement.

## Controlled Target-Environment Test Prerequisites

1. Apply the reviewed migration sequence through `0052_driver_offer_economics.sql` with a dedicated DDL identity and a tested rollback plan.
2. Run `check-driver-offer-economics-target-preflight.sh` only with `ECONOMICS_TEST_ENVIRONMENT=staging` and distinct read-only inspection/runtime identities. It refuses any other environment label.
3. Create an isolated staging tenant, zone, synthetic rider, synthetic driver, and test vehicle. Do not use customer, driver, vehicle, or payment records.
4. Supply `DATABASE_URL`, `REDIS_URL`, `INTERNAL_SERVICE_TOKEN`, and matching configuration from the target secret system; no secrets are encoded in scripts.
5. Use an approved, versioned commission/floor/index policy, with commercial ownership and activation/expiry dates.
6. Confirm map/routing, identity, payment, notification, commerce, and webhooks only through each provider’s approved sandbox or test tenant.
7. Monitor database transition errors, unfulfilled economics outcomes, policy-version distribution, worker queue age, errors/timeouts, idempotency collisions, and financial invariants. Define rollout abort thresholds before enablement.

> This local evidence demonstrates source behavior. It is not production evidence, provider certification, legal advice, regulatory approval, insurance approval, financial advice, or a readiness sign-off.
