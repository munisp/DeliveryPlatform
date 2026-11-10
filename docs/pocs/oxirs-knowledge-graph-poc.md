# POC: oxirs Knowledge-Graph Platform (TIME-BOXED, SANDBOXED)

- **Status:** proposed / time-boxed (10 working days)
- **Upstream:** https://github.com/cool-japan/oxirs (Apache-2.0), pinned to tag `v0.4.1`
- **Owner:** TBD (assign before Day 1)
- **Compose:** `deploy/testing/docker-compose.oxirs-poc.yml` (isolated `poc` network, localhost-only)
- **Blast radius:** none. Zero production wiring, zero production data, zero production network attachment.

> **POC ONLY — do not attach to production networks or data.**
> oxirs is a sandboxed evaluation target behind a throwaway API facade.
> It must never sit on a money path or an identity path.

## 1. Objective

Evaluate oxirs (Rust knowledge-graph platform: SPARQL/GraphQL over RDF,
GeoSPARQL, DID/verifiable credentials, SHACL) for **two candidate use cases
only**:

1. **DID / Verifiable-Credential pilot** — issuance, presentation, and
   revocation (StatusList2021) of driver/merchant KYC credentials.
2. **GeoSPARQL semantic spatial queries** — e.g. "driver within service zone",
   over entities **mirrored** from Postgres/PostGIS. Postgres/PostGIS remains
   the source of truth; oxirs only ever holds a read-model mirror.

Anything outside these two use cases is out of scope for this POC.

## 2. Explicit non-goals

- **No production traffic.** The POC stack runs on an isolated Docker network
  with ports bound to `127.0.0.1` only.
- **No replacement of PostGIS.** PostGIS stays the authoritative spatial store;
  oxirs is evaluated strictly as a semantic query adjunct.
- **No replacement of TigerBeetle** or any money-path component.
- **No Kafka dependency.** Kafka support was removed upstream in v0.4.1
  (the `oxirs-stream-adapter-rdkafka` quarantine adapter was retired). If
  streaming mirror updates are ever needed, the supported option is NATS or
  MQTT bridging (`oxirs-stream` ships MQTT 5.0 and NATS federation code), not
  Kafka.
- **No production identity/KYC decisions** may be gated on oxirs output during
  the POC. DID/VC work uses synthetic test identities only.

## 3. Known risk posture (why this is a sandboxed POC)

- **Fabrication history:** oxirs changelogs self-admit to fabricated
  conformance and benchmark claims in earlier releases (supposedly fixed in
  later "hardening" releases). We therefore trust nothing upstream claims and
  re-run their conformance harness ourselves (Day 8).
- **Solo maintainer / bus factor:** effectively a single-maintainer project.
- **Low adoption:** ~11.6k total crate downloads; minimal community.
- **No published container image:** build-from-source only (see compose file).
- **Volatile surface:** breaking changes between minor versions (e.g. Kafka
  removal in v0.4.1).

Decision: sandboxed POC only, behind an API facade, never production-critical.

## 4. Time-box: 10 working days

| Day | Work item | Exit artifact |
|-----|-----------|---------------|
| 1 | Setup + smoke: build `oxirs-fuseki` from pinned tag `v0.4.1` via `deploy/testing/docker-compose.oxirs-poc.yml`; confirm `/$/ping` health, SPARQL endpoint, empty-dataset query/update roundtrip. | Smoke notes; build reproducibility log (incl. build time and toolchain pin). |
| 2 | Data mirror design: map driver/merchant/service-zone rows to RDF vocab; define named-graph layout; provenance triples (`prov:wasDerivedFrom` back to Postgres PKs). | Ontology/mapping doc (1 page). |
| 3 | Data mirror implementation: Postgres/PostGIS extract -> N-Quads bulk import into oxirs; target ~1M triples from synthetic data. | Import script + load-time measurement. |
| 4 | SPARQL facade spike: thin internal HTTP facade exposing 3-5 canned query shapes ("driver within zone", "valid credential for merchant", ...); facade owns all oxirs-specific detail. | Facade spike + latency baseline harness. |
| 5 | GraphQL facade spike: same queries via oxirs GraphQL endpoint; compare ergonomics/correctness vs SPARQL path. | Facade comparison notes. |
| 6 | DID/VC spike: did:web or did:key issuance of driver/merchant KYC credentials; verification roundtrip; StatusList2021 revocation roundtrip. All verified by **our** tests against the running server, not upstream docs. | Issuance + verification + revocation test scripts and results. |
| 7 | SHACL data-quality validation: write shapes for mirrored entities (required fields, coordinate validity, credential expiry windows); run validation over the mirror. | Shapes file + validation report. |
| 8 | Independent verification of upstream claims: re-run the upstream SHACL conformance harness (W3C SHACL test suite runner in-repo) **ourselves**; re-run a SPARQL correctness spot-set (W3C SPARQL 1.1 cases) on our hardware; compare against published numbers. | Conformance rerun report: pass/fail counts, deltas vs upstream claims. |
| 9 | GeoSPARQL correctness: 1000 sampled (driver-point, zone-polygon) pairs; compare `geof:sfWithin` / topological predicate results from oxirs against PostGIS `ST_Within` ground truth. Performance runs: p95 latency on 1M triples / 2 vCPU. | Correctness diff report + perf numbers. |
| 10 | Kill/keep decision gate: compile evidence, score against success criteria (§5) and kill conditions (§7); write recommendation. | Decision memo (keep-as-adjunct / keep-extended-POC / kill). |

Hard stop: no extensions beyond Day 10 without a new, separately approved
time-box.

## 5. Success criteria (measurable)

| # | Criterion | Threshold | Measured by |
|---|-----------|-----------|-------------|
| S1 | SPARQL query latency | p95 < 200 ms on 1M triples, 2 vCPU / 4 GB container limit, for each canned facade query | Day 9 latency harness (our tooling) |
| S2 | DID issuance + verification | Issue -> verify roundtrip passes in **our** test script against the running server, 100/100 iterations | Day 6 test script |
| S3 | StatusList2021 revocation | Revoke -> verify-fails roundtrip passes in **our** tests, including revocation-list consistency after restart | Day 6 test script |
| S4 | GeoSPARQL correctness | >= 99.5% agreement with PostGIS `ST_Within` ground truth on 1000 sampled driver/zone pairs; every disagreement root-caused | Day 9 diff report |
| S5 | SHACL validation | Our entity shapes run to completion over the full mirror; validation report is machine-readable and reproducible | Day 7 report |
| S6 | Upstream SHACL conformance rerun | We reproduce the harness and record the true pass rate; any fabrication of the claimed rate is itself a kill trigger (§7) | Day 8 report |
| S7 | Facade isolation | All oxirs-specific types/endpoints confined to the facade; swapping the facade backend for Jena/Fuseki or qendpoint requires no caller changes | Day 5 code review |

## 6. Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Fabricated conformance/benchmark claims recur | High | High (wrong keep decision) | Day 8 independent harness rerun on our hardware; trust only our measurements (S2/S3/S6 explicitly exclude upstream claims). |
| Bus factor / solo maintainer abandons project | Medium | Medium | oxirs sits behind a facade (S7); standard SPARQL endpoint means swap-in of Apache Jena/Fuseki or qendpoint is cheap; POC artifacts (shapes, mappings, facade) are engine-agnostic by design. |
| Low adoption -> unvetted bugs, no community support | High | Medium | Sandboxed only, synthetic data only, resource-limited container, isolated network; no production path exists to be affected. |
| Scope creep into money path or identity gating | Medium | Critical | Non-goals (§2) and kill conditions (§7); any discovered money-path requirement is an automatic kill, not an expansion. |
| Build-from-source fragility (no published image) | Medium | Low | Tag pinned to `v0.4.1`; Day 1 records toolchain and build reproducibility; failure to build reproducibly feeds the decision gate. |
| GeoSPARQL predicate semantics drift from PostGIS/OGC | Medium | Medium | S4 ground-truth diff against PostGIS on 1000 sampled pairs before any reliance. |
| Streaming gap (Kafka removed upstream) | Low | Low | Mirror is batch N-Quads import for the POC; if streaming is ever needed, NATS/MQTT bridging is the upstream-supported option (§2). |

## 7. Exit criteria

**Kill immediately (any one):**

- K1: Any requirement or proposal emerges to put oxirs on a money path
  (payments, ledger, payouts) or as an authoritative identity/KYC store.
- K2: Day 8 conformance rerun fails materially (SHACL pass rate meaningfully
  below the upstream claim, or evidence of fresh fabrication).
- K3: Maintenance stalls during the POC (upstream repo unresponsive/deleted,
  or the pinned tag cannot be built reproducibly by Day 3).
- K4: S4 GeoSPARQL correctness falls below 99.5% with unexplainable
  disagreements (semantic spatial answers we cannot trust are worse than
  none).
- K5: Container cannot run within 2 vCPU / 4 GB at the 1M-triple scale.

**Keep conditions (all):** S1-S7 met, no kill condition triggered, and the
facade swap test (S7) demonstrates a credible Jena/Fuseki or qendpoint
fallback.

**Default at Day 10:** if evidence is incomplete or mixed, the default
decision is **kill** (tear down stack, archive docs), not extend.

## 8. Teardown

At POC end (any outcome): `docker compose -f deploy/testing/docker-compose.oxirs-poc.yml down -v`,
delete the `poc` network and volumes, archive the facade/tests/reports under
`docs/pocs/` results appendix. Nothing persists in production systems.
