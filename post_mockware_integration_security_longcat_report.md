# Post-Mockware Integration, Edge Security, and LongCat Verification

## Executive Conclusion

The locally runnable verification suite passed after the silent-mockware remediation and edge hardening changes. The platform now has regression coverage for explicit degraded behavior, Caddy/APISIX configuration invariants, and LongCat provider failure modes. However, the repository is **not yet production-ready** because the production dependency audit still reports **140 vulnerabilities**, including **3 critical** and **55 high** findings. Live, containerized end-to-end traffic has also not been executed in this sandbox because Docker and the required staged dependencies are unavailable.

| Verification area | Locally proven result | Remaining requirement |
|---|---|---|
| System and integration behavior | Seven focused suites passed with 34 tests; the full suite previously passed 58 tests across 15 files, with 28 intentional skips. | Run against a real PostgreSQL, Redis, Keycloak, APISIX, Caddy, Open AppSec, Dapr, Lakehouse, Temporal, Kafka/Fluvio, and TigerBeetle staging topology. |
| Silent-mockware behavior | Lakehouse and workspace source failures are explicit; no plausible fallback analytics are returned. | Wire verified schemas for deliberately disabled domain workspaces before enabling them. |
| Caddy and APISIX edge posture | Static hardening tests passed; Caddy is now configured as public TLS edge and APISIX management listeners are disabled. | Start the container stack and validate TLS issuance, HTTP-to-HTTPS behavior, reverse-proxy headers, real OIDC redirects, and rate-limit enforcement. |
| Open AppSec policy | Prevention mode, suspicious-automation prevention, and Caddy hostname targets are now represented in policy. | Attach the policy to a live Open AppSec enforcement point; the repository previously contained policy only, not a runnable WAF service topology. |
| LongCat | Provider success, offline failure, malformed structured output, deterministic fallback, consent rules, and terminal voice-session behavior are tested. | Exercise load, prompt-injection, PII redaction, model latency, and real operator override flows against a deployed local model. |

## Test Evidence

The following command completed successfully after the configuration and LongCat changes:

```bash
pnpm exec vitest run \
  tests/edge-security.config.test.ts \
  tests/longcat.integration.test.ts \
  tests/integration-probes.test.ts \
  tests/operational-events.integration.test.ts \
  tests/system.integration.test.ts \
  tests/platform.scenarios.test.ts \
  tests/silent-mockware.regression.test.ts \
&& pnpm check
```

| Suite | Passed checks | Coverage demonstrated |
|---|---:|---|
| `edge-security.config.test.ts` | 3 | Caddy public edge, APISIX admin/control disablement, HTTPS CORS restrictions, Keycloak credential removal, and Open AppSec hostname enforcement policy. |
| `longcat.integration.test.ts` | 6 | Valid provider JSON, offline fallback, malformed JSON fallback, dispatch fallback, callback consent, and terminal voice session lifecycle. |
| Integration, operational-event, system, scenario, and mockware suites | 25 | Explicit integration states, event bridge behavior, health posture, source failure handling, and false-success regression protection. |
| TypeScript | 0 errors | Source and route contracts compile after the remediation and edge changes. |

## Caddy, APISIX, Keycloak, and Open AppSec Security Remediation

The edge stack previously exposed internal services and APISIX management listeners directly. The current implementation adds `deploy/gateway/caddy/Caddyfile`, makes Caddy the intended public HTTP/HTTPS ingress, removes host-published PostgreSQL, Redis, OpenSearch, Permify, etcd, Keycloak, and APISIX ports, and preserves only ports 80/443 on Caddy.

| Component | Security change | Benefit |
|---|---|---|
| Caddy | Disabled Caddy admin API, enforced trusted private proxy ranges, configured TLS forwarding, compression, HSTS, MIME sniffing protection, referrer policy, browser permission policy, opener/resource isolation headers, and removed `Server` header. | Narrows public ingress and provides a consistent TLS/security-header boundary. |
| APISIX | Disabled admin and control listeners in declarative config; retained request rate limiting; narrowed CORS to HTTPS edge origins; forces `X-Forwarded-Proto: https`. | Prevents public management access and reduces cross-origin plus scheme-confusion risk. |
| Keycloak | Uses production `start` mode, requires deploy-time PostgreSQL and admin passwords, trusts forwarded headers, has strict hostname configuration, adds Caddy HTTPS callback/origin, and removes seeded users and known default passwords. | Eliminates committed default accounts and forces real secret provisioning. |
| Open AppSec | Keeps prevention/learning mode, changes suspicious automation to prevention, and adds HTTPS targets for `switchos.localhost` and `auth.localhost`. | Aligns the WAF policy intent with the Caddy edge hostnames. |

> **Important:** The Open AppSec policy is now hardened, but the repository still needs a live Open AppSec container or managed enforcement-point attachment in the runtime topology. A policy file by itself does not block traffic.

## Dependency Vulnerability Audit

`pnpm audit --prod --audit-level=high` completed with a nonzero exit because the current production dependency graph reports the following unresolved findings.

| Severity | Count |
|---|---:|
| Critical | 3 |
| High | 55 |
| Moderate | 71 |
| Low | 11 |
| **Total** | **140** |

At least part of the exposure is inherited through the Mojaloop dependency tree, including a transitive `nanoid@3.3.12` path with a patched version listed as `>=3.3.17`. These findings must be triaged and remediated through supported upstream Mojaloop dependency upgrades or a tested dependency override program before any production release. The audit result is a release blocker, not an informational warning.

## LongCat Robustness Assessment

LongCat is reasonably robust for **availability and output-shape failures**, but it is not yet a complete production AI safety system.

| Capability | Verified behavior | Assessment |
|---|---|---|
| Provider outage | Failed Ollama requests return deterministic heuristic guidance with `source.provider = heuristic`, `available = false`, and a reason. | Strong fail-closed provenance behavior. |
| Malformed provider output | Invalid JSON now falls back explicitly rather than being treated as successful AI output. | Strong structured-output resilience. |
| Partial provider output | Text and list normalizers replace missing or malformed fields with deterministic fallback content. | Good contract stability. |
| Dispatch evidence gaps | Absent trip-radar and airport-readiness data stays `null`, and fallback risk flags say no conclusion is inferred. | Prevents zero-value fabrication. |
| Consent and voice lifecycle | Automatic callback dispatch requires explicit customer wording or operator metadata; terminal sessions reject new turns. | Good operational guardrails. |
| Prompt safety and privacy | Prompts advise against inventing unavailable capabilities, but no dedicated adversarial prompt-injection, PII-redaction, content moderation, or data-minimization test is present. | Remaining production hardening work. |
| Load and latency | A 60-second provider timeout exists, but no load, circuit-breaker, queueing, or SLO verification is present. | Remaining production hardening work. |

## Required Staging Exit Criteria

Before release, the platform should pass the following tests in a production-like environment: full container-stack boot; Caddy certificate and redirect checks; APISIX-to-application and Keycloak OIDC browser round trip; Open AppSec attack-blocking checks; authenticated rate-limit checks; database migration and reconciliation checks; Kafka/Fluvio/Dapr/Temporal event delivery; LongCat failure, latency, prompt-injection, and PII scenarios; and dependency remediation with no unresolved critical or high production vulnerabilities.
