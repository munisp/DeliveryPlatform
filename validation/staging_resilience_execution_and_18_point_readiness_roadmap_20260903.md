# Staging Resilience Execution Runbook and 18-Point Production-Readiness Roadmap

**Purpose.** This runbook supplies the exact prerequisites and configuration sequence for executing the repository’s guarded distributed k6 ingress test and Toxiproxy payment-path fault suite in a real staging cluster. It then translates the current **82/100 protected-staging** assessment into eighteen independently defined readiness gates.

> **Boundary:** This is a production-readiness plan, not a claim that 100/100 has been achieved. The score is an internal evidence ledger, not a third-party product-parity score. Literal feature, source, endpoint, schema, UI, or behavioural parity with another product is neither assessed nor claimed.

## 1. Non-negotiable staging boundary

Run the suites only against a dedicated resilience environment, preferably an isolated staging cluster. If a shared staging cluster is unavoidable, use a dedicated node pool, distinct namespaces, separate ingress hostnames, an isolated PostgreSQL database/role, a separate Redis instance/database, and sandbox-only payment credentials. Do **not** reconfigure a shared payment deployment that receives ordinary staging traffic to point at the provider simulator.

| Boundary | Required state | Acceptance check |
|---|---|---|
| Kubernetes context | A named context that is explicitly classified non-production, for example `delivery-staging-resilience`. The exact context name is passed to the scripts through `RESILIENCE_TEST_CONTEXT`. | `kubectl config current-context` exactly equals `RESILIENCE_TEST_CONTEXT`. The runner refuses a mismatch. |
| Namespace | `resilience-test`, labelled `resilience.delivery-platform.io/environment=non-production`. | The runner reads the namespace label and refuses to continue if it is absent or different. |
| Traffic targets | Distinct HTTPS ingress hostnames for the resilience matching and payment services. Hostnames must not include `prod` or `production`. | The k6 runner rejects non-HTTPS and production-like hostnames before calling Kubernetes. |
| Database | A disposable PostgreSQL 16 + PostGIS database and dedicated least-privilege role. No shared production/staging financial data. | Database name/role and test dataset ID are recorded in the dossier; teardown/recreation is demonstrable. |
| Cache | Separate Redis logical instance/database, key prefix, and credentials for the run. Redis remains an accelerator only. | Redis contains only run-scoped test keys; PostgreSQL invariant probes remain the assignment authority. |
| Payment route | A test-only payment-webhook deployment points to the cluster-local Toxiproxy proxy, which points only to the test provider simulator. | DNS/egress probe verifies no production provider address can be reached from the test workload. |
| Data | Synthetic or formally approved de-identified drivers, trips, payment references, and route/geofence fixtures. | Dataset card, seed revision, record counts, and deletion/teardown result are attached to the run dossier. |
| Access | Separate roles for experiment author, SRE approver, finance/compliance reviewer, and archive reader. | Negative RBAC and secret-access checks pass; service accounts cannot access ordinary application or production namespaces. |

## 2. Cluster and deployment prerequisites

### 2.1 Required platform capabilities

The resilience cluster must satisfy these technical prerequisites before a test is scheduled.

| Component | Required configuration | Why it is required |
|---|---|---|
| Worker topology | At least three matching replicas and at least two payment-webhook replicas, placed across at least two failure domains/nodes where the platform supports it. Configure PDBs and anti-affinity/topology spread policy. | A single pod cannot demonstrate multi-pod routing, drain, claim recovery, or horizontal capacity behavior. |
| Ingress and DNS | TLS-terminated, test-only ingress routes to the resilience workloads; request IDs preserved or generated at ingress; rate limiting disabled only within the approved test window or configured transparently. | k6 must measure the real staging ingress/service path, not direct pod loopback. |
| PostgreSQL/PostGIS | Version and extensions match the intended target class; tested backup/WAL retention configuration; resource monitoring; connection limits explicitly budgeted for applications, k6 traffic effects, and administrative probes. | The matching and financial durable authority must be included in the measurement and recovery evidence. |
| Redis | TLS/authentication and network policy as intended; independent capacity/latency monitoring; run-scoped key namespace; cache loss/reconciliation test plan. | Redis acceleration cannot be allowed to conceal a durable assignment failure. |
| Metrics and tracing | Scrapeable metrics endpoint/collector for matching, webhook queue, provider calls, pool waits, Redis fallback, and business invariants; trace/log correlation with `release_id` and `resilience_run_id`. | k6 percentiles without durable and dependency signals are insufficient evidence. |
| k6 Operator | Version-pinned installation, CRD present, controller images approved, `TestRun` lifecycle tested in the resilience namespace. | The repository’s TestRun manifest requires the `k6.io` CRD. k6 documents `script` and `parallelism` as required TestRun fields.[1] |
| Toxiproxy | Version-pinned deployment running only in `resilience-test`, restricted control-plane access, port 8666 exposed only to the test payment workload. | The proxy is for controlled simulator-path latency, timeout, reset, bandwidth, loss, and outage experiments—not live-gateway certification.[2] |
| Provider simulator | Reviewed test-only service reproducing the current local fixture’s verified collection/transfer contract, requiring a test bearer token, and retaining only redacted request logs. | The application must receive a known verification result while Toxiproxy changes only the network path. |
| Secret delivery | Staging external-secret/workload-identity integration creates the test secret; credentials are never committed, printed, placed in ConfigMaps, or reused from production. | The k6 script needs test-only internal and webhook signing tokens; the simulator needs a separate test provider token. |
| Chaos control | One approved Kubernetes chaos framework, namespace-scoped RBAC, explicit target allowlists, TTL/cleanup policy, and a kill switch. | Node/pod/network experiments must be bounded and observable. |

### 2.2 Required test-specific deployments

Deploy a dedicated resilience revision of the matching and payment services, not a configuration mutation of shared staging services.

| Workload | Required resilience configuration |
|---|---|
| Matching worker | Separate `DATABASE_URL` to the disposable Postgres database; separate `REDIS_URL`; the tested pool and candidate settings; immutable image digest; three replicas; internal test token from the staged secret store; matching ingress hostname. |
| Payment webhook worker | Separate `DATABASE_URL`; `PAYMENT_WEBHOOK_SECRET` and internal token from a test-only secret; test-only provider API key; `PAYMENT_PROVIDER_NAME=fixturepay` or an approved simulator identity; `PAYMENT_VERIFY_URL_TEMPLATE=http://payment-provider-toxiproxy.resilience-test.svc.cluster.local:8666/transaction/verify/{reference}`; corresponding transfer templates if payout lifecycle is included; two replicas; payment ingress hostname. |
| Provider simulator | Cluster-local, test-only service. Its verification response must match the field names validated by the handler: provider reference, successful status, `120000` minor-unit amount, `NGN`, and provider transaction ID. It must reject an absent/wrong test bearer token. |
| Toxiproxy | Apply `deploy/kubernetes/resilience-test/toxiproxy/toxiproxy.yaml`; configure the proxy upstream as `provider-simulator.resilience-test.svc.cluster.local:8080`; configure the payment worker to reach its provider through `payment-provider-toxiproxy.resilience-test.svc.cluster.local:8666`. |
| k6 runner | Uses `resilience-k6-runner` service account, test-only secret `resilience-k6-credentials`, the repository ConfigMap-mounted script, and three parallel runner jobs. It needs no Kubernetes API token. |

The current test fixture accepts `GET /transaction/verify/{reference}` with `Authorization: Bearer <test-token>` and returns a successful verified collection with a `120000` minor-unit `NGN` amount. The staging simulator must be tested against the actual provider client parser before beginning a chaos scenario.[3]

### 2.3 Namespace, RBAC, and network configuration

Create and label the namespace once through reviewed infrastructure-as-code. The illustrative commands below should be executed from a controlled administrator workstation only after change approval; replace values with the organization’s approved context and registry/image policies.

```bash
export RESILIENCE_TEST_CONTEXT=delivery-staging-resilience
kubectl config use-context "$RESILIENCE_TEST_CONTEXT"

kubectl create namespace resilience-test
kubectl label namespace resilience-test \
  resilience.delivery-platform.io/environment=non-production \
  --overwrite

kubectl -n resilience-test apply \
  -f deploy/kubernetes/resilience-test/k6/k6-runner-service-account.yaml \
  -f deploy/kubernetes/resilience-test/toxiproxy/toxiproxy.yaml
```

The namespace must also have a reviewed `ResourceQuota`, `LimitRange`, default-deny `NetworkPolicy`, and explicit egress allowances only to: the isolated matching/payment ingress targets where required, disposable PostgreSQL, isolated Redis, cluster DNS, the provider simulator, Toxiproxy control access from the authorised operator path, and approved telemetry/archive endpoints. Permit the payment-resilience workload to contact only the in-namespace Toxiproxy service for its provider verification path. Deny all production DNS names/IP ranges at egress where the CNI supports it.

The k6 runner service account should retain `automountServiceAccountToken: false`, as supplied in the repository template. The k6 Operator controller needs its own separately reviewed RBAC in its system namespace; do not grant k6 runner jobs cluster-admin or broad Secret read access.

### 2.4 Test-only secret configuration

An approved staging secret backend must create the following **names and keys**, with values supplied out of band. Do not create literal values in Git, terminal history, k6 output, screenshots, or run reports.

| Secret | Required keys | Consumer | Rules |
|---|---|---|---|
| `resilience-k6-credentials` in `resilience-test` | `internal-service-token`, `payment-webhook-secret` | k6 TestRun only | Values are randomly generated sandbox/test credentials and must match the resilience service configuration. |
| `resilience-payment-provider` in `resilience-test` | `provider-api-key` | Payment worker and provider simulator | Separate test key; rotate after exercise; never reuse a production merchant/API credential. |
| `resilience-service-database` | Separate connection fields or rendered URL | Resilience matching/payment workloads | Role has access only to the disposable database/schema. |
| `resilience-redis` | Redis endpoint and password/token | Resilience matching workload | Isolated Redis instance/database and test key prefix. |

Verify only the secret object/key presence from the administrator session; never decode or print the values:

```bash
kubectl -n resilience-test get secret resilience-k6-credentials \
  -o jsonpath='{.data.internal-service-token}' | grep -q .
kubectl -n resilience-test get secret resilience-k6-credentials \
  -o jsonpath='{.data.payment-webhook-secret}' | grep -q .
```

The repository’s runner performs the same key-presence check and will stop if either key is absent.

### 2.5 Synthetic dataset preparation

Before each run, recreate or reset the dedicated database and cache. Seed at least the tested 5,000 available driver records, 5,000 requested trips, 500 completed-pending-payment trips, corresponding fare quotes/provider payments/settlements, durable driver eligibility/presence, and the expected service zone. Populate the isolated Redis GEO set with only the test drivers. Use a run-specific range or prefix so every ID can be purged deterministically.

The k6 test’s defaults assume IDs compatible with the existing fixture conventions:

| k6 setting | Default | Required seeded counterpart |
|---|---|---|
| `TRIP_ID_PREFIX` | `30000000-0000-0000-0000-` | Existing requested trip UUIDs, with a numeric 12-digit suffix. |
| `TRIP_OFFSET` | `1` | Start index of the requested-trip set. |
| `PAYMENT_REFERENCE_PREFIX` | `peak-payment-` | Provider-payment references, e.g. `peak-payment-1`. |
| `PAYMENT_OFFSET` | `1` | Start index of payment test records. |
| `PAYMENT_EVENT_PREFIX` | `k6-payment-event-` | Run-scoped provider event IDs. |

Do not seed a payment reference twice without an explicit duplicate-callback scenario. The standard ingress load test expects unique events and validates durable acknowledgement; duplicate/replay cases belong in a separately tagged, lower-rate scenario with its own assertions.

## 3. Exact guarded execution procedure

### 3.1 Preflight

The following preflight checklist must be completely green before a run window is opened.

| Step | Command or verification | Pass condition |
|---|---|---|
| 1. Confirm exact context | `kubectl config current-context` | Exactly the named non-production context. |
| 2. Confirm namespace label | `kubectl get ns resilience-test -o jsonpath='{.metadata.labels.resilience\.delivery-platform\.io/environment}'` | Prints `non-production`. |
| 3. Confirm k6 CRD | `kubectl api-resources --api-group=k6.io -o name` | Includes `testruns`. |
| 4. Confirm runner secret keys | Key-presence commands in §2.4. | Both keys are present; values not printed. |
| 5. Confirm test workloads | `kubectl -n resilience-test get deploy,pod,svc,ingress` | Matching/payment/simulator/Toxiproxy targets are ready and use immutable approved images. |
| 6. Confirm service health | Hit the test ingress health endpoints with the approved test probe. | Matching and payment health responses succeed. |
| 7. Confirm simulator path | From the payment test pod, resolve/connect only to the Toxiproxy service; Toxiproxy shows proxy upstream as the provider simulator. | No direct provider sandbox/production egress. |
| 8. Record baseline | Capture 10-minute no-fault low-load telemetry: latency, error classes, queue age, pool wait, DB/Redis metrics, and invariants. | Baseline is within approved expected range. |
| 9. Confirm approvers | SRE experiment owner, product observer, finance owner, and compliance/security reviewer named for payment/safety scenarios. | Approval/change identifier recorded. |
| 10. Set kill switch | Verify the operator can scale test workloads to zero, delete TestRun, call proxy `clear`, and remove fault manifests. | Cleanup commands have been rehearsed. |

### 3.2 Run the distributed ingress test

Run only after the preflight is recorded. The exact environment variables below represent a bounded initial workload equivalent to the validated local profile. They are not a production capacity declaration; increase in stages only after every prior stage passes.

```bash
export RESILIENCE_TEST_CONTEXT=delivery-staging-resilience
export RESILIENCE_TEST_NAMESPACE=resilience-test
export TARGET_ENV=staging
export CONFIRM_NON_PRODUCTION_RESILIENCE_TESTS=run
export MATCHING_BASE_URL=https://matching.resilience.staging.example.example
export PAYMENT_BASE_URL=https://payments.resilience.staging.example.example
export RUN_ID=resilience-$(date -u +%Y%m%dT%H%M%SZ)
export MATCH_RATE_PER_SECOND=80
export MATCH_DURATION=15m
export PAYMENT_RATE_PER_SECOND=10
export PAYMENT_DURATION=15m
export PRE_ALLOCATED_VUS=50
export MAX_VUS=250
export TRIP_OFFSET=1
export PAYMENT_OFFSET=1
export ARTIFACT_DIR="$PWD/validation/resilience_runs/$RUN_ID"

scripts/testing/resilience/run-k6-ride-payment-ingress.sh
```

The example hostnames are documentation placeholders and must be replaced with real test-only DNS names that do not contain `prod` or `production`. Do not run this command unchanged. The script creates the k6 script/config ConfigMaps, checks the test secret, creates the `ride-payment-ingress` TestRun, and writes the created TestRun manifest into the artifact directory.

Observe the run without copying sensitive logs to unrestricted systems:

```bash
kubectl -n resilience-test get testrun,pods,jobs -w
kubectl -n resilience-test get events --sort-by=.metadata.creationTimestamp
```

A run is not passed merely because runner pods exit successfully. Record the k6 summary and then run the protected operational and database invariant probes. Required postconditions include: no duplicate active offer/assignment; no missing durable match outcome for a successful matching request; no unverified financial transition; balanced ledger; webhook queue drains or each remaining item has a correctly classified retry/quarantine state; zero unaccounted provider/simulator responses; and no unexpected retention of test data.

### 3.3 Execute a Toxiproxy gateway-fault scenario

Toxiproxy is initially for the **test provider simulator path only**. It is not a mechanism to proxy or certify the real provider sandbox. For sandbox provider resilience, use provider-approved test facilities and/or a separately approved egress fault technique after the basic simulator scenarios pass.

Deploy and establish the proxy:

```bash
export RESILIENCE_TEST_CONTEXT=delivery-staging-resilience
export RESILIENCE_TEST_NAMESPACE=resilience-test
export TARGET_ENV=staging
export CONFIRM_NON_PRODUCTION_GATEWAY_FAULTS=run
export PROVIDER_SIMULATOR_UPSTREAM=provider-simulator.resilience-test.svc.cluster.local:8080

scripts/testing/resilience/toxiproxy-payment-faults.sh deploy
scripts/testing/resilience/toxiproxy-payment-faults.sh ensure
scripts/testing/resilience/toxiproxy-payment-faults.sh status
```

Run **one fault at a time** against a fixed callback burst. First run the baseline test with `clear`. Then add a fault, run a specifically labelled low-rate k6 callback test or controlled callback corpus, observe the queue and provider dashboards, remove the fault, wait for queue recovery, and execute the financial invariant/reconciliation probe.

| Scenario | Command | Required observed result |
|---|---|---|
| Baseline | `toxiproxy-payment-faults.sh clear` | Provider verification works; queue age remains low; no quarantine/invariant failure. |
| Latency/jitter | `toxiproxy-payment-faults.sh latency 300 100` | HTTP callback acceptance stays within its measured SLO where capacity permits; provider latency and queue signals increase; verified money state occurs only after verification. |
| Timeout | `toxiproxy-payment-faults.sh timeout 1000` | Worker classifies failure as retryable; event remains durable; no ledger/payout state changes before verified retry. |
| TCP reset | `toxiproxy-payment-faults.sh reset 0` | Bounded retry/jitter; no duplicate effect after recovery. |
| Bandwidth cap | `toxiproxy-payment-faults.sh bandwidth 64` | Queue and provider latency telemetry reflect degradation; recovery drains safely. |
| Packet loss | `toxiproxy-payment-faults.sh loss 0.10 0.25` | Retry classification/recovery remains bounded; no accepted event is lost. |
| Upstream outage | `toxiproxy-payment-faults.sh down` | Callback `202` represents durable acceptance only; no capture/payout occurs from callback data; queue/alert rises; recovery/reconciliation succeeds after `clear`. |

Always end an experiment with:

```bash
scripts/testing/resilience/toxiproxy-payment-faults.sh clear
scripts/testing/resilience/toxiproxy-payment-faults.sh status
```

Then record all queue states, provider/simulator evidence, ledger and reconciliation output. A fault experiment remains **failed** if the proxy fault did not occur, cleanup did not happen, telemetry was missing, or an invariant probe was skipped.

### 3.4 Artifact collection and cleanup

After every run, archive the structured dossier described in `compliance_release_audit_evidence_archive_20260903.md`: run charter/approval, exact source/config/image hashes, k6 summary, TestRun/pod/job/event logs, dashboard export, trace/log links, database/Redis/proxy probes, queue/reconciliation output, chaos/fault timeline, cleanup proof, and pass/fail/re-test decision. Archive redacted identifiers and digests rather than secrets, raw HMAC keys, PAN/CVV, or unnecessary raw location data.

Tear down only after artifact capture and invariant verification. Delete TestRun/Jobs, delete test ConfigMaps, scale or delete the test workloads, clear proxy toxics, remove test secrets through the secret backend, rotate sandbox keys, delete/recreate the database/cache, and validate no run-prefixed keys/records remain.

## 4. Remaining 18 points: 82/100 to a conditional 100/100 readiness ledger

The following eighteen one-point gates explain the arithmetic **planning ledger** from 82 to 100. A point is granted only after the stated evidence is approved. The ledger must not be treated as automatic, and a final 100/100 still means only that this independent readiness rubric has been satisfied for an explicitly approved launch scope—not third-party parity or a substitute for ongoing operational judgment.

| # | Remaining point | Current gap | Required evidence to grant the point | Accountable approval |
|---:|---|---|---|---|
| 1 | Multi-pod matching SLO | Existing sub-200-ms result is single-process/loopback, not ingress + replicas + failure domains. | At least two of three production-like multi-pod peak runs meet approved p95/p99/error targets while PostgreSQL offer/assignment probes show zero violations. | SRE and product. |
| 2 | Asynchronous payment-completion SLO | Callback acceptance is measured; received-to-verified/settled completion percentiles and queue recovery objective are not. | Instrumented p50/p95/p99 queue/verification completion, approved age/recovery objective, outage/recovery runs, and no financial invariant failure. | SRE and finance control. |
| 3 | Admission control and capacity policy | Safe local result used 24 matching clients per worker; scale/overload behavior is not accepted. | Per-pod concurrency, ingress rate limits, 429/retry contract, HPA behavior, DB connection budget, and load-test evidence at expected launch demand plus headroom. | SRE and product. |
| 4 | Offer-projection/outbox recovery | Redis offer projection is non-authoritative but still post-commit synchronous; durable outbox delivery SLO is unproven. | Outbox/reconciler delivery, cache-eviction and redis-outage recovery, no double offer, backlog/age alert, and operator drill. | SRE and product operations. |
| 5 | Real payment-provider sandbox protocol | Current positive evidence uses local fixture provider only. | Selected provider sandbox callback registration, signature validation, verification, idempotency, credential rotation, certificate/TLS behavior, and support escalation evidence. | Finance control and security. |
| 6 | Complete financial lifecycle and reconciliation | Refund, dispute/chargeback, payout-status reconciliation, finance close, and exception workflow have not all been certified with provider. | End-to-end sandbox lifecycle results, daily reconciliation, exception register, controlled manual repair approval, and balanced ledger proof. | Finance control and compliance. |
| 7 | Target secret backend and workload identity | Templates exist; target external-secret, OIDC/workload identity, and rotation operation are not proven. | Secret fetch/rotation/revocation drill; no static cloud key; negative access tests; audit logs; rollback. | Security and SRE. |
| 8 | Target CNI and NetworkPolicy enforcement | Existing kind validation had CNI limitations; policy existence is not enforcement evidence. | Egress/ingress deny and allow probes, DNS/metadata controls, test namespace isolation, and payment no-production-egress test in target CNI. | Security and SRE. |
| 9 | Supply-chain and deployment integrity | Immutable image placeholders and runtime verification were not a real rollout. | Signed image digests, SBOM/vulnerability policy, provenance, admission enforcement, staged rollout, rollback rehearsal, and runtime scan evidence. | Security and SRE. |
| 10 | Live observability and alert response | Dashboard/threshold design exists; matching/payment metric endpoints, scrape rules, alerts, and routing are not demonstrated. | Metrics implementation, dashboard provisioning, firing/acknowledgement/recovery tests, on-call routing, and immutable evidence bundle. | SRE. |
| 11 | Backup, WAL/PITR, and restore | Documented plans/containers are not a timed target-environment restoration. | Encrypted backup/WAL process, RPO/RTO acceptance, timed restore to isolated environment, ledger/assignment/reconciliation checks, and corrective re-test. | SRE and finance control. |
| 12 | Failure/chaos and incident exercise | Guarded k6/Toxiproxy templates are not executed in staging; no completed multi-pod game day. | Approved pod/network/cache/provider/database fault experiments, cleanup, recovery, postmortem, and corrected runbooks. | SRE, security, finance/compliance as applicable. |
| 13 | Routing/ETA source and quality | Route planning persists deterministic plans, but selected production routing/traffic source, licensing, and measured quality are open. | Versioned adapter, source/license approval, held-out segment scorecard, feasibility/legal constraints, outage/degradation behavior, and product-owner sign-off. | Product and compliance/safety. |
| 14 | Map/geofence policy acceptance | Spatial structures exist; full authoring/versioning/playback/accuracy/offline/shadow enforcement acceptance remains. | Geometry checksum/version controls, boundary/accuracy/hysteresis tests, shadow/field metrics, override/rollback drill, privacy/retention review. | Product and compliance/safety. |
| 15 | Real mobile attestation and fraud controls | Server rules exist but live device attestation, spoof/replay/collusion resistance and false-positive governance remain unproven. | Real-device test corpus, red-team results, human review/appeal workflow, consent revocation, emergency path, and model/rule audit trail. | Security, safety, product. |
| 16 | Enterprise tenant and integration controls | Tenant-oriented domains/integration patterns exist; hard query/cache isolation, SSO/SCIM, public API lifecycle, partner governance, and support remain unaccepted. | Tenant leakage tests, authorization review, SSO/SCIM tests, API/deprecation/replay/DLQ policy, partner sandbox/certification, and audit export. | Product, security, enterprise operations. |
| 17 | Privacy, retention, audit, and support operations | Evidence archiving and data retention are specified but target operations are not implemented/proven. | Approved data map, minimization/access/deletion tests, tamper-evident audit storage/retrieval drill, support-case controls, retention/legal-hold evidence. | Compliance and security. |
| 18 | Jurisdictional commercial approval | Code/workflow cannot establish current transport, payment, tax, insurance, privacy, consumer-protection, and incident-reporting authorization. | Dated written approvals or qualified counsel/provider/insurance assessments for actual launch geography, service model, data flows, and funds flow; renewal ownership. | Compliance lead and executive sponsor. |

### Readiness decision rule

No point can offset a failure of a hard gate. Any unverified monetary transition, unbalanced ledger, duplicate active assignment, harmful enforcement action, tenant data leak, inability to restore, unauthorized production access, or absent regulatory/insurance/payment approval remains a **release blocker** even if seventeen other points are complete. The score becomes 100 only after all 18 evidence gates are independently accepted for the launch scope, and it must be periodically revalidated as dependencies, providers, policies, releases, and jurisdictions change.

## References

[1]: https://grafana.com/docs/k6/latest/set-up/set-up-distributed-k6/usage/configure-testrun-crd/ "Grafana k6 Operator TestRun configuration"

[2]: https://github.com/Shopify/toxiproxy "Toxiproxy documentation"

[3]: ../scripts/testing/run-ride-payment-provider-fixture.mjs "Existing local test provider fixture"

[4]: ../scripts/testing/resilience/run-k6-ride-payment-ingress.sh "Guarded distributed k6 runner"

[5]: ../scripts/testing/resilience/toxiproxy-payment-faults.sh "Guarded Toxiproxy payment-path fault runner"

[6]: ride_matching_payment_latency_and_cleanroom_acceptance_20260903.md "Latency evidence and remaining gaps"

[7]: cleanroom_logistics_capability_completion_20260903.md "Independent capability completion assessment"

[8]: compliance_release_audit_evidence_archive_20260903.md "Compliance release evidence archive specification"
