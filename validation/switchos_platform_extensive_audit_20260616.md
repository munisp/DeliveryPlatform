# SwitchOS Elite Operator Dashboard Extensive Audit

**Author:** Manus AI  
**Date:** 2026-06-16  
**Scope:** TypeScript operator shell, legacy PostgreSQL/Drizzle domain layer, Rust services, Go services, Python services, middleware claims, operator UX, PWA posture, native-mobile posture, security controls, production readiness, and end-to-end data-flow consistency.

## Executive Assessment

The current repository contains **substantial pockets of real platform logic**, especially in the **legacy PostgreSQL/Drizzle domain layer**, the **Rust pricing and dispatch services**, the **Python intake orchestrator**, and parts of the **Go notification and Mojaloop payment services**. However, the platform is **not production-ready** in its present state. The most important reason is not merely that some features are incomplete; it is that the codebase is **architecturally split between a narrowed active runtime and a much richer but mostly disconnected legacy/service layer**. In practical terms, the repository contains meaningful logic, but the live operator experience does not consistently execute that logic end to end.

The business-logic audit therefore produces a **mixed result**. The repository is **far above a generic CRUD scaffold**. At the same time, it does **not yet reach integrated enterprise-grade parity** with the Uber-plus-DoorDash ambition because many of the strongest rule systems are either **static in the active shell**, **orphaned in `server/db.ts`**, or **implemented in side services that are not clearly wired into live user journeys**.

The security assessment is materially worse. The active Node edge currently constructs identity by **base64-decoding a cookie value without signature verification** and then trusting the resulting user object, while protected routes only check that `ctx.user` exists, not whether it is authentic, scoped, tenant-bound, or authorized. The lakehouse service exposes unauthenticated ingest, query, metrics, and analytics endpoints with highly permissive CORS, and multiple auxiliary services are network-exposed without authentication, rate limiting, or gateway enforcement. Against OWASP ASVS, this falls well below a production security baseline [1].

| Dimension | Score | Verdict | Core reason |
|---|---:|---|---|
| Business-rule and domain-logic quality | **5.8 / 10** | Mixed / partially strong | Deep logic exists, but it is fragmented and not consistently live |
| Middleware implementation depth | **2.9 / 10** | Weak | Most named middleware is declared, adjacent, or absent rather than operationally integrated |
| Security posture | **2.3 / 10** | High risk | Identity forgery, open internal services, missing authz, missing edge controls |
| Data-flow consistency | **4.0 / 10** | Inconsistent | Active runtime serves simplified/static paths while richer logic sits outside the main flow |
| UX maturity for operator web | **6.1 / 10** | Serviceable shell | Cohesive operator shell exists, but several experiences remain summary-grade |
| PWA readiness | **1.2 / 10** | Not ready | No manifest, no service worker, no offline/install flow |
| Native-mobile readiness | **0.8 / 10** | Not implemented | Mobile is represented as dashboard content, not a native delivery surface |
| Overall production readiness | **3.2 / 10** | **Not ready for production** | Security, integration, persistence, and control-plane gaps are blocking |

## Audit Method

This assessment reviewed the currently active TypeScript runtime, the legacy PostgreSQL/Drizzle business-logic layer, the Rust pricing and dispatch services, the Go notification, provisioning, and Mojaloop services, the Python intake and lakehouse services, and the client routing and analytics surfaces. The report also compared declared middleware ambitions against repository evidence and evaluated whether the current implementation satisfies a production verification mindset consistent with OWASP ASVS [1]. For CORS posture, the assessment also used FastAPI’s own guidance that wildcard origins are not the correct pattern for credentialed or tightly controlled production communication [2].

## Business-Rule and Domain-Logic Quality Audit

The platform’s **strongest business-rule asset** is the large `server/db.ts` module. The active read region alone shows concrete operational modeling for driver performance scoring, membership plans, customer memberships, review sentiment seeding, order tracking events, and experiment rollout guardrails. Repository-wide export discovery shows that the same module also contains broad logic for dispatch, ETA, routing, loyalty, referrals, campaign variants, merchant channels, phone ordering, tableside ordering, white-label apps, and service recovery. In other words, the repository does contain a serious business domain model; the problem is that much of it is **stranded outside the active runtime**.

The **active TypeScript router**, by contrast, is intentionally narrow and structurally coherent, but most active workspaces are backed by `server/lib/platformWorkspaces.ts`, which serves **hard-coded, synthetic summary payloads** rather than invoking the richer database layer or the polyglot services. This gives the live shell a credible demonstration shape, but not a production-grade operational substrate.

### Service and Feature Business-Logic Scores

| Service or feature area | Score | Assessment |
|---|---:|---|
| Active TypeScript operator shell and tRPC surface | **4.5 / 10** | Coherent and buildable, but most current route handlers serve summary-grade or static payloads rather than live operational logic |
| Legacy PostgreSQL/Drizzle domain layer (`server/db.ts`) | **7.8 / 10** | Broad, rule-heavy, and materially deeper than a CRUD backend; however, it is partially incompatible and not fully attached to the active runtime |
| Rust pricing engine | **8.1 / 10** | Strong marketplace pricing heuristics with surge guardrails, vertical handling, courier offers, and marketplace quote composition |
| Rust dispatch optimizer | **8.3 / 10** | Solid heuristic depth for assignment, trip radar, batching, ETA, and driver ranking |
| Go notification dispatcher | **6.7 / 10** | Useful idempotency, fallback, dead-letter, and template behavior, but provider delivery is simulated and infrastructure depth is shallow |
| Go vertical provisioning | **7.0 / 10** | Sensible readiness scoring heuristics and vertical playbook logic, though bounded in scope |
| Go Mojaloop payment service | **5.3 / 10** | Some real quote/transfer semantics exist, but settlement durability, reconciliation rigor, and access control are not production-grade |
| Python intake orchestrator | **7.5 / 10** | Clear multi-vertical intake, compliance, fulfillment, batching, and substitution branching |
| Python lakehouse analytics service | **5.8 / 10** | Provides usable aggregation logic, but it is a lightweight file-backed analytics service, not a true production lakehouse |
| Operator analytics page | **4.8 / 10** | Mixes live operational hotspot data with hard-coded revenue and vertical charts, weakening decision-grade trust |
| Merchant channels / service recovery / phone ordering active pages | **4.4 / 10** | Connected as operator pages, but presently summary-oriented rather than deeply transactional |
| Tableside commerce / white-label apps / driver mobility active pages | **5.0 / 10** | Better than placeholders, but still largely reporting surfaces over simplified server payloads |

### Middleware and Platform Component Scores

The user asked for explicit attention to the middleware stack. The repository evidence indicates a sharp distinction between **implemented**, **adjacent**, and **claimed-only** components. That distinction matters more than whether a URL or environment variable exists.

| Middleware or platform component | Score | Observed state |
|---|---:|---|
| PostgreSQL | **7.4 / 10** | Real and central to the repository’s richest domain logic, but the active runtime does not consistently expose that logic end to end |
| Lakehouse | **4.6 / 10** | Active file-backed analytics service exists, and a Postgres bridge exists, but the currently active analytics router does not appear to use it |
| Kafka | **3.1 / 10** | A standalone Kafka-to-Delta connector exists in Python, but it is not visibly wired into the live platform flow |
| Mojaloop | **5.2 / 10** | Quote and transfer logic exists, but the service behaves more like a sandboxed adapter than a regulated production payment rail |
| APISIX | **1.0 / 10** | Environment variables exist, but no concrete integration or routing policy was found in the active code path |
| Fluvio | **1.0 / 10** | Service URL is declared, but no functional integration was found |
| Redis | **1.0 / 10** | Dependencies are present, but no concrete runtime use was found in the audited path |
| TigerBeetle | **0.8 / 10** | The real ledger is replaced by an in-memory map-based stand-in, which is non-durable and non-auditable |
| Keycloak | **0.8 / 10** | OAuth server URL is declared, but no evidence of robust token verification or Keycloak policy enforcement exists in the active edge |
| OpenSearch | **0.5 / 10** | No concrete integration found |
| Dapr | **0.0 / 10** | No concrete integration found |
| Temporal | **0.0 / 10** | No concrete integration found |
| Permify | **0.0 / 10** | No concrete integration found |
| OpenAppSec | **0.0 / 10** | No concrete integration found |

### Interpretation of the Middleware Scores

The low middleware scores do **not** mean the platform has no ambition. They mean the repository, as audited today, does **not substantiate production-grade implementation** of those components in the live path. In some cases, such as Kafka and the lakehouse, there are meaningful adjacent artifacts. In others, such as Dapr, Temporal, Permify, and OpenAppSec, the claimed component is effectively absent from the executable surface I audited.

## UX, PWA, and Native-Mobile Audit

The current operator web application is a **credible restored shell**. Routes are intentionally narrowed, navigation is coherent, and the visual surface now reflects connected workspaces rather than broken scaffolds. That is a meaningful recovery outcome. However, the platform still behaves more like an **operator demonstration shell** than a complete cross-surface commerce operating system. Several workspaces summarize a domain rather than orchestrating it transactionally.

The PWA and native-mobile story is materially weaker. The HTML entry document contains only basic page metadata, and the frontend bootstrap registers neither a service worker nor any install/offline capability. There is no manifest wiring, no push registration bootstrap, no native bridge, and no evidence of React Native, Expo, Capacitor, or similar runtime delivery. The FastAPI/React documentation context makes clear that production communication patterns requiring credentials should use explicit origin control rather than broad wildcard policy [2]. The present frontend does not yet implement the installability, offline continuity, device registration, or mobile packaging required to support a true multi-surface operator and consumer ecosystem.

| UX surface | Score | Assessment |
|---|---:|---|
| Operator web UX | **6.1 / 10** | Clear, navigable, and significantly better than before, but still too summary-driven for mission-critical operations |
| PWA capability | **1.2 / 10** | No manifest, no service worker, no offline caching, no install prompt, no background sync |
| Native mobile capability | **0.8 / 10** | Not implemented as a native/mobile runtime; represented largely as dashboard concepts and copy |

## Security Audit

The security posture is the platform’s most serious blocker. The active Node entrypoint reads a session cookie, base64-decodes it, parses JSON, and trusts the resulting object as the authenticated user. There is **no signature verification, JWT verification, session lookup, nonce check, issuer validation, or audience validation** in that path. The same code also defaults the role to `admin` when the cookie payload omits one. The tRPC middleware then treats all protected procedures as authorized if `ctx.user` exists. This creates a **critical identity forgery vulnerability** and a **critical authorization failure**.

The lakehouse service is likewise exposed in an unsafe way. It allows wildcard origins, wildcard methods, wildcard headers, and credentialed CORS configuration at the same time, while exposing unauthenticated `/ingest`, `/query`, `/tables`, `/metrics`, and analytics endpoints. FastAPI’s own documentation recommends explicit allowed origins for correct credentialed communication rather than wildcard allowance [2]. Even if browser behavior limits some credentialed wildcard scenarios, the service remains far too open for production and lacks a defensible trust boundary.

The Go Mojaloop service, notification dispatcher, vertical provisioning service, Rust services, and intake orchestrator all expose business endpoints without evidence of authentication, tenancy enforcement, rate limiting, or gateway mediation. The payment service additionally uses in-memory state for quotes and transfers and accepts callback updates without message authentication or signature validation. Internally, that means a compromised network peer could manipulate state; externally, any exposed route would become a direct abuse surface.

### Security Severity Register

| Severity | Finding | Evidence and impact |
|---|---|---|
| **Critical** | Forged operator identity via unsigned cookie payload | `server/_core/index.ts` constructs `ctx.user` by base64-decoding cookie JSON and trusting the result; `server/_core/trpc.ts` only checks user presence. An attacker can mint arbitrary operator identity and role values. |
| **Critical** | No meaningful authorization or tenancy enforcement | Protected procedures check only for a user object, not tenant, role, scope, or ownership boundaries. This enables horizontal and vertical privilege abuse. |
| **Critical** | Lakehouse ingest and query surfaces are open | `services/python/lakehouse/main.py` exposes unauthenticated ingestion, query, table metadata, metrics, and analytics endpoints. This allows data poisoning, scraping, and internal reconnaissance. |
| **High** | Over-permissive lakehouse CORS posture | Wildcard origins, methods, and headers with credentials enabled create an unsafe and unclear cross-origin policy boundary [2]. |
| **High** | No API gateway or edge hardening in active Node shell | The active Node edge lacks rate limiting, CSRF protection, CORS middleware, security headers, request identity verification, and abuse controls. |
| **High** | Payment callbacks and initiation endpoints lack trust verification | `services/go/mojaloop/main.go` accepts transfer and quote callbacks and initiation requests without request authentication, signing, or source verification. |
| **High** | Internal services are broadly network-exposed | Rust and Python services bind to `0.0.0.0` or equivalent public interfaces, while Go services expose business routes without gateway or mTLS controls. |
| **Medium** | Durable financial controls are absent | TigerBeetle is replaced by an in-memory map ledger, and quote/transfer state is stored in memory. This undermines auditability, reconciliation, and crash safety. |
| **Medium** | Incomplete TLS trust posture for PostgreSQL | `server/db.ts` permits `rejectUnauthorized: false` when SSL is enabled, which weakens certificate validation. |
| **Medium** | Reproducible dependency audit is blocked | `pnpm audit` could not run because the repository lacks a `pnpm-lock.yaml`, preventing reliable software composition analysis in the audited workspace. |
| **Medium** | Legacy SQL construction needs hardening review | Much of `server/db.ts` uses safe parameterization, but some dynamic SQL fragments and interpolated interval clauses warrant explicit hardening review before production exposure. |

### External and Internal Exploitability Assessment

From an **external attacker** perspective, the most concerning paths are the forged cookie-based identity model, the unauthenticated lakehouse HTTP surface, and any exposed auxiliary service routes that sit outside a gateway. From an **internal attacker or compromised-service** perspective, the lack of service-to-service authentication, the unauthenticated lakehouse ingestion endpoints, the mutable in-memory financial state, and the absence of tenant-scoped authorization create obvious abuse paths. In its current state, this platform should be treated as **highly vulnerable** if placed on a production network.

## Data-Flow Consistency Audit

The codebase currently fails the user’s requirement that data flow consistently through all features without orphaned paths. The core issue is that the repository has **three separate truth layers**. The first is the **active TypeScript shell**, which is clean and buildable. The second is the **legacy PostgreSQL domain layer**, which is much richer but largely outside the active flow. The third is the **polyglot service layer**, which contains meaningful logistics and payments logic but is not clearly orchestrated from the live operator routes.

This leads to a platform where several features appear operational in the UI but are, in practice, **summary views over hard-coded or simplified payloads**. The analytics page is the clearest example: queue pressure and hotspot cards are fed by live API calls, but revenue and vertical charts remain hard-coded. The page also contains a lakehouse status badge, yet the currently active analytics router points to `platformWorkspaces` rather than the Node lakehouse bridge. That means the UI advertises an analytics architecture more advanced than the active router actually provides.

### Data-Flow Consistency Findings

| Flow | Current state | Audit conclusion |
|---|---|---|
| Operator page → tRPC → active server summaries | Working | Technically coherent, but often summary-grade rather than transactional |
| Operator page → tRPC → legacy PostgreSQL domain functions | Mostly disconnected | Large amount of real business logic exists but is not the active path |
| Operator page → TypeScript → Rust pricing / dispatch services | Not clearly wired | Strong service logic exists, but live route usage is not evident in the active shell |
| Operator page → TypeScript → Go notification / Mojaloop services | Mostly disconnected | Services exist, but end-to-end operator actions do not clearly drive them |
| PostgreSQL → Node lakehouse bridge → Python lakehouse → analytics UI | Partially implemented but currently inconsistent | Bridge exists, lakehouse exists, UI expects lakehouse states, but active router currently serves platform-workspace summaries |
| Mobile/PWA claims → actual runtime delivery | Disconnected | Mobile and PWA are represented in product language, not implemented runtime delivery surfaces |
| Merchant channels / phone ordering / service recovery UI → durable backend workflows | Weakly connected | Pages render coherent operational summaries, but fully stateful orchestration is not yet demonstrated |

### Data-Flow Consistency Score

The platform receives a **4.0 / 10** for data-flow consistency. That score is not lower because the repository is not random or incoherent; it has a real architectural direction. But it is also not higher because too many paths are **architecturally present yet operationally orphaned**.

## Is the Platform Ready for Production?

The answer is **no**. The platform is **not ready for production**.

This conclusion is driven first by **security blockers**, second by **data-flow fragmentation**, and third by **non-durable middleware substitutions**. The presence of sophisticated business logic in isolated modules does not compensate for a production edge that can trust forged user identity, nor for an analytics subsystem that exposes ingestion and query endpoints without access control, nor for a financial subsystem that substitutes a ledger with in-memory maps.

| Production gate | Status | Why it blocks go-live |
|---|---|---|
| Authenticated identity and session integrity | **Fail** | Current operator identity can be forged from unsigned cookie content |
| Authorization and tenancy enforcement | **Fail** | No demonstrated tenant, role, scope, or policy enforcement in active protected routes |
| Secure service-to-service trust | **Fail** | Internal services trust the network rather than authenticated principals |
| Gateway and WAF controls | **Fail** | APISIX/OpenAppSec are claimed but not integrated into the active path |
| Durable finance and settlement integrity | **Fail** | In-memory ledger and transfer state are not acceptable for production finance |
| End-to-end feature integration | **Fail** | Active UX often bypasses or omits richer underlying logic |
| PWA / native-mobile delivery | **Fail** | Product claims exceed actual implementation |
| Dependency governance and reproducibility | **Fail** | Missing lockfile prevents reliable audit and release reproducibility |

## Priority Gaps to Resolve Before Production

The first priority is to **replace the active authentication model completely**. The Node edge must stop trusting decoded cookie JSON and instead validate signed sessions or verified JWTs against a proper identity provider, ideally with issuer, audience, expiry, and rotation controls. If Keycloak is a requirement, it must be integrated as a real trust anchor rather than remaining an environment variable.

The second priority is to establish **authorization and tenancy policy**. Protected procedures must enforce tenant boundaries, role scopes, administrative separation, and resource ownership. If Permify is part of the intended architecture, it needs to be implemented rather than claimed.

The third priority is to **put every externally reachable service behind a real edge**. APISIX, equivalent gateway controls, or another hardened ingress layer must mediate authentication, rate limiting, origin policy, request validation, and observability. If OpenAppSec is part of the intended stack, it should protect those entrypoints rather than existing only in the architectural narrative.

The fourth priority is to **reconnect the active operator shell to the real backend logic**. The restored TypeScript routes should progressively shift from `platformWorkspaces` synthetic summaries to the legacy PostgreSQL functions and the Rust/Go/Python services. This is the only way to meet the user requirement that the platform supersede Uber and DoorDash in actual behavior rather than in roadmap language.

The fifth priority is to **replace non-durable financial and analytics substitutions**. TigerBeetle cannot remain an in-memory balance map. Mojaloop state cannot remain process-local. The active lakehouse cannot remain an unauthenticated JSONL file sink if it is intended as a production analytics backbone.

The sixth priority is to **either implement or de-scope the named middleware components**. Dapr, Temporal, Fluvio, Redis, OpenSearch, OpenAppSec, APISIX, Keycloak, and Permify should not appear as effective capabilities until concrete, testable integration exists.

The seventh priority is to **ship release discipline**. Add a lockfile, deterministic dependency management, secure configuration handling, integration tests that exercise real service paths, and deployment manifests that reflect the intended production topology.

## Recommended Remediation Sequence

| Order | Remediation | Outcome |
|---|---|---|
| 1 | Replace forged-cookie auth with verified identity and real sessions/JWT validation | Removes the most severe compromise path |
| 2 | Add authorization and tenancy controls across tRPC and service endpoints | Prevents lateral and administrative abuse |
| 3 | Put all services behind authenticated gateway ingress and rate limiting | Establishes a defensible edge |
| 4 | Rewire active routes to real DB/service flows | Aligns visible UX with actual business logic |
| 5 | Replace in-memory TigerBeetle/Mojaloop state with durable persistence | Makes financial flows auditable and crash-safe |
| 6 | Harden or isolate lakehouse ingestion/query surfaces | Prevents analytics poisoning and data leakage |
| 7 | Implement or remove claimed middleware dependencies | Aligns architecture claims with reality |
| 8 | Add lockfiles, SCA, integration tests, and deployment controls | Improves release readiness and repeatability |
| 9 | Build real PWA/mobile delivery surfaces or de-scope them from production claims | Aligns product promise with implementation |

## Final Verdict

The current SwitchOS repository is **not a hollow scaffold**. It contains meaningful platform logic and several genuinely strong service-level rule systems. That matters. But the platform is still **too fragmented, too trusting, and too loosely controlled** to go live. The correct executive summary is therefore: **promising technical substrate, meaningful business-rule depth, but decisively not production-ready**.

## References

[1]: https://owasp.org/www-project-application-security-verification-standard/ "OWASP Application Security Verification Standard (ASVS)"
[2]: https://fastapi.tiangolo.com/tutorial/cors/ "FastAPI CORS Tutorial"
