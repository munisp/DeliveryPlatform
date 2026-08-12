# Dependency Audit Remediation & LongCat Architecture

## Slide 1 — Title
**DeliveryPlatform Security Remediation, Expo SDK 54 Path, and LongCat LLM Architecture**

Subtitle: **Post-mockware verification briefing**

Visual direction: dark logistics-control-tower background; thin cyan data paths; coral risk indicator.

## Slide 2 — Executive Decision

| Topic | Current evidence | Decision |
|---|---|---|
| Critical production vulnerabilities | Reduced from 3 to 0 | Cleared in current runtime graph |
| High production vulnerabilities | Reduced from 55 to 16 | Expo SDK 54 toolchain upgrade remains a release blocker for zero-high policy |
| Regression coverage | 62 tests passed; root and mobile TypeScript checks passed | Safe direct upgrades validated |
| Live edge verification | Docker/Caddy unavailable in this sandbox | Run supplied staging verifier in Docker-capable environment |

Key message: **Do not force nested Expo transitive overrides. Upgrade Expo through its supported SDK process and prove native behavior.**

## Slide 3 — What Was Remediated

Show a horizontal reduction funnel: **3 critical / 55 high → 0 critical / 16 high**.

Text callouts:
- Removed unused vulnerable production trees: Mojaloop npm SDK/tools, gRPC packages, Firebase Admin, Socket.IO.
- Updated active direct dependencies: Express 5.2.1, tRPC 11.18.0, Axios 1.19.0, Drizzle 0.45.2, Nanoid 5.1.16, PostCSS 8.5.26.
- Verified no tracked runtime imports before removing each unused package.

## Slide 4 — Residual Expo SDK 54 Risk Map

Architecture stack diagram:

**SwitchOS Native Mobile** → **Expo SDK 54** → **Expo CLI / Metro / config plugins / Babel-Jest** → remaining high advisories

| Remaining package families | Typical path | Risk status |
|---|---|---|
| `brace-expansion`, `fast-uri`, `js-yaml`, `nanoid`, `postcss` | SDK 54 build and developer tooling | Requires supported Expo SDK dependency refresh or incremental SDK upgrade |
| `image-size` | Metro path | No patched upstream version listed; requires upstream replacement or mitigation |

Key message: **The unresolved findings are SDK-managed build-tool dependencies, not active platform business-service code. They still block a strict production security gate.**

## Slide 5 — Exact Expo SDK 54 Upgrade and Validation Sequence

1. Create a dedicated upgrade branch and retain a clean baseline: `pnpm test`, root `pnpm check`, mobile `pnpm --filter app-template check`, and `pnpm audit --prod`.
2. In `mobile/switchos-native`, refresh to the latest patch in the SDK 54 line: `pnpm exec expo install expo@^54.0.0 --fix`.
3. Run `pnpm exec expo-doctor` and resolve every SDK compatibility issue it reports.
4. Use `pnpm exec expo install <package>` for all Expo-owned modules rather than manually editing their versions.
5. If using Continuous Native Generation, delete previously generated `ios/` and `android/` folders and regenerate with `npx expo prebuild`; otherwise run `npx pod-install` and apply the Native Project Upgrade Helper changes.
6. Run `pnpm --filter app-template test`, `pnpm --filter app-template check`, `npx expo start --clear`, Android and iOS development builds, and physical-device smoke tests.
7. Re-run `pnpm audit --prod`. If high findings remain, move incrementally from SDK 54 to the next supported SDK, repeating the same procedure one SDK at a time.

Footer citation: Expo recommends incremental upgrades, `expo install --fix`, `expo-doctor`, and native-project regeneration/upgrade steps. [1]

## Slide 6 — LongCat’s Intended Role

Headline: **LongCat is the LLM-centric operational intelligence layer.**

| Domain | Verified evidence in | LLM output |
|---|---|---|
| Consumer concierge | Caller context, memory, channel state, call friction | Personalized recommendations, operator script, accessible actions |
| Merchant consultant | Channel mix, benchmark evidence, forecast inputs | Demand outlook, menu/channel actions, financial watchouts |
| Dispatch intelligence | Supply telemetry, readiness, candidate ranking | Dispatch brief, batching strategy, risk flags, reallocations |

Design principle: LongCat synthesizes **verified operational evidence** into structured, auditable guidance. It does not invent missing evidence.

## Slide 7 — LongCat LLM Architecture

Diagram:

**Verified platform data** → **domain-specific LongCat prompt** → **Ollama local LLM** → **structured JSON parser + normalizer** → **operator workflow UI**

Below the primary path, show fallback branch:

**Provider error / malformed output / HTTP 503** → **deterministic heuristic guidance** → `source.execution_mode = "heuristic_fallback"`

Primary path label: `source.execution_mode = "llm"`.

Emphasize that provenance travels with every response, so heuristic continuity is never presented as an LLM answer.

## Slide 8 — Controlled LongCat Failure Verification

| Simulated condition | Expected behavior | Verified result |
|---|---|---|
| Network failure (`fetch` rejects) | Deterministic consumer fallback, unavailable source, reason retained | Passed |
| Structured JSON response | Merchant guidance marked `llm` | Passed |
| Malformed model response | Heuristic fallback marked unavailable and `heuristic_fallback` | Passed |
| HTTP 503 | Dispatch fallback preserves verified evidence and candidate ranking | Passed |
| Callback consent and terminal voice session | Unsafe dispatch is denied; closed sessions reject further turns | Passed |

Test evidence: `tests/longcat.integration.test.ts` — 6 / 6 passed.

## Slide 9 — Edge and Staging Verification

The repository now includes `scripts/verify-staging-edge.sh`.

| Live check | Success criterion |
|---|---|
| Caddy TLS | `https://<public-host>/healthz` returns 200 |
| Redirect | `http://<public-host>/healthz` redirects to HTTPS |
| Keycloak OIDC | Discovery endpoint returns 200 through Caddy |
| Open AppSec | Suspicious automated probe is blocked with 403, 406, or 429 |

Current constraint: Docker and Caddy are unavailable in this sandbox. These checks must run in the real staging topology.

## Slide 10 — Release Gates and Next Actions

| Gate | Status | Owner action |
|---|---|---|
| Critical audit findings | Complete | Maintain zero-critical regression gate |
| Expo SDK 54 residual highs | Open | Run supported patch refresh, then incremental Expo SDK upgrade if necessary |
| Mobile native validation | Open | Test Android, iOS, web, and development builds after every Expo SDK step |
| Live Caddy / Keycloak / Open AppSec proof | Open | Deploy stack and run `scripts/verify-staging-edge.sh` |
| LongCat production hardening | Open | Add load, latency, prompt-injection, PII-redaction, and human-override evaluations |

Closing message: **The platform now fails transparently rather than fabricating success. The remaining work is controlled SDK modernization and real staging proof.**

## References

[1]: https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/ "Expo: Upgrade Expo SDK walkthrough"
[2]: https://pnpm.io/10.x/settings "pnpm 10.x workspace settings and dependency resolution"
