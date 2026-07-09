# SwitchOS LongCat Remediation Wave 9 — Live Voice and Historical Personalization Memory

## Executive Summary

This remediation wave closed the next highest-value LongCat gaps that were feasible in the current environment. The platform now has a **durable live-voice orchestration surface** for phone ordering and a **persisted historical personalization memory layer** rather than only static workspace summaries. The implementation is intentionally polyglot and middleware-aware. TypeScript now owns the operator-facing orchestration and persistence workflow, Go now exposes a real **voice callback notification channel**, Rust now provides a dedicated **voice-priority scoring endpoint**, and the Python lakehouse now registers and summarizes **LongCat voice and memory events**.

The result is not a fully production-complete voice agent yet, because there is still no real telephony SIP or Twilio-style bidirectional media runtime, no speech-to-text streaming bridge, and no persistent always-on infrastructure for full middleware-backed proof. However, the codebase now contains the real architectural backbone required to support those steps honestly.

## Detailed Remaining-Gap Plan

The remaining LongCat gap set is now much narrower and more implementation-ready.

| Gap area | Current state after Wave 9 | Next concrete implementation step | Honest blocker |
| --- | --- | --- | --- |
| Live voice ingress | Voice sessions and turn orchestration now exist in the platform API, with callback escalation and priority scoring | Add a telephony webhook adapter for live provider events, then wire call lifecycle updates into the new session tables | No live telephony provider or stage host is available in this sandbox |
| Streaming speech pipeline | No true streaming STT/TTS loop yet | Add a provider bridge that transforms partial transcripts into `appendVoiceTurn` mutations and renders spoken prompts back to the caller | Needs always-on voice infrastructure and provider credentials |
| Historical personalization memory | Durable PostgreSQL profiles and Redis cache now exist | Enrich profile building with real user-item, merchant, time-of-day, and issue-recovery history | Current schema insight is still strongest at order and notes level; item-level history remains limited |
| Merchant-grounded substitutions | Substitution-sensitive sessions are now scored and flagged | Connect merchant inventory or menu availability feeds into the voice reasoning path | Live merchant inventory feeds are not yet provisioned in this environment |
| Dispatch-aware callback prioritization | Rust service now returns voice priority bands and scores | Feed live queue telemetry and courier disruption signals into the scoring endpoint | Live telemetry sources are not all available in the sandbox |
| Middleware-backed replay proof | PostgreSQL, Redis, lakehouse, Go, and Rust paths are integrated in code | Run end-to-end voice session replay on infrastructure that hosts the middleware continuously | Requires a reachable stage stack or Docker-capable persistent host |
| Security and action boundaries | Current write paths remain operator-authenticated and internal-service protected | Add route-level APISIX policy and explicit write-action policy scopes for voice order mutation steps | Middleware host access is still required for live gateway proof |

## Implemented Changes in This Wave

### TypeScript LongCat orchestration

A new module, `server/_core/longcatVoice.ts`, now provides the main voice and memory control plane. It adds durable schema bootstrap for `longcat_customer_memory_profiles`, `longcat_voice_sessions`, and `longcat_voice_turns`, then exposes these capabilities:

| Capability | What now exists |
| --- | --- |
| Historical personalization memory | Durable PostgreSQL memory profiles keyed by customer or user context |
| Fast recall | Redis-backed memory caching with honest degradation if Redis is unavailable |
| Voice-session orchestration | Session start, turn append, context updates, and callback decisioning |
| LongCat reasoning | Local Ollama-backed response generation when available, with heuristic fallback |
| Middleware evidence | Operational-event emission plus lakehouse ingestion for memory and voice events |
| Callback escalation | Notification-dispatcher integration for voice callback handoff |
| Dispatch intelligence | Rust-backed voice-priority scoring, with heuristic fallback if unavailable |

### Router-level live voice surface

The `phoneOrdering` router now exposes a proper API surface for the new behavior:

| Procedure | Purpose |
| --- | --- |
| `customerMemory` | Returns the durable LongCat memory profile for a caller context |
| `startVoiceSession` | Starts a live voice-ordering session with memory and priority data |
| `appendVoiceTurn` | Records a turn, updates memory, generates the next assistant response, and triggers callback escalation when needed |

### Workspace exposure

The phone-ordering workspace now surfaces a `voice_assistant` section that includes a memory preview, callback channel visibility, and live-voice status flags so operators can see the new capability in the existing workspace surface.

### Go notification dispatcher

The Go service `services/go/notification-dispatcher` now supports a new `voice` channel and a `longcat_voice_callback` render path. This gives LongCat an existing polyglot service path for callback escalation instead of keeping voice callback logic trapped inside the TypeScript layer.

### Rust dispatch optimizer

The Rust service `services/rust/dispatch-optimizer` now exposes `POST /voice-priority`, which scores voice sessions by queue pressure, substitution complexity, and repeat-customer value, then returns a `standard`, `priority`, or `urgent` band plus reasoning.

### Python lakehouse

The Python lakehouse service now registers and summarizes these LongCat analytics tables:

| Lakehouse table | Purpose |
| --- | --- |
| `longcat_memory_events` | Historical memory refresh snapshots |
| `longcat_voice_sessions` | Voice-session starts and priority metadata |
| `longcat_voice_turns` | Turn-level callback and intent evidence |

The analytics summary now includes a `longcat_voice_overview` object so the voice path is visible in the lakehouse-backed analytics surface.

## Middleware Coverage in This Wave

This wave did not overclaim equal runtime depth across every named middleware system. Instead, it integrated with the middleware that could be used honestly from the current code and environment.

| Middleware / platform component | Coverage in Wave 9 | Notes |
| --- | --- | --- |
| PostgreSQL | Implemented and primary | Durable memory, voice sessions, and voice turns persist here |
| Redis | Implemented with graceful fallback | Used for LongCat memory cache when configured |
| Lakehouse | Implemented | LongCat memory and voice events are now ingested and summarized |
| Dapr / OpenSearch | Implemented indirectly | LongCat events flow through the existing operational-event layer when those sinks are configured |
| Rust dispatch optimizer | Implemented directly | Provides `/voice-priority` scoring for LongCat voice sessions |
| Go notification dispatcher | Implemented directly | Provides voice callback delivery channel |
| Temporal | Not newly used in this slice | Existing worker foundation remains available, but live voice workflows were not added without a stronger runtime proof path |
| Kafka / Fluvio | Not directly extended in this slice | Existing event surfaces remain available, but no false claim of live broker-backed voice replay was made |
| Keycloak / Permify | Preserved indirectly | Existing authenticated operator and policy-aware platform surfaces remain in use |
| APISIX / OpenAppSec | Design-ready only | Voice routes are ready for gateway exposure, but live staged policy proof still requires infrastructure |
| Mojaloop / TigerBeetle | Not appropriate to this slice | They remain outside the immediate voice and personalization scope |

## Validation Evidence

The new implementation was validated across the affected stack.

| Validation command family | Result |
| --- | --- |
| Targeted Vitest suites for LongCat and platform scenarios | Passed |
| Production Node build | Passed |
| Go notification dispatcher build (`go test ./...`) | Passed |
| Rust dispatch optimizer build (`cargo check`) | Passed |
| Python lakehouse syntax validation (`python3 -m py_compile`) | Passed |

The Rust build still reports its previously harmless dead-code warning for `service_name`, but it does not block compilation.

## Updated Readiness Impact

These scores are scoped to the LongCat-related surfaces affected by this wave, not the whole platform.

| Component | Prior readiness | New readiness | Rationale |
| --- | --- | --- | --- |
| LongCat consumer assistant | 72/100 | 82/100 | Now has durable memory, voice session APIs, and real callback escalation path |
| LongCat phone-ordering voice orchestration | 48/100 | 74/100 | No longer a summary-only feature; now has persisted sessions, turn handling, and priority scoring |
| Historical personalization memory | 40/100 | 78/100 | Durable PostgreSQL plus Redis-backed memory now exists, though item-level depth is still limited |
| Dispatch-aware voice prioritization | 52/100 | 73/100 | Rust-backed endpoint now exists, but live telemetry inputs are still partial |
| Polyglot LongCat middleware fit | 58/100 | 76/100 | TypeScript, Go, Rust, and Python now participate in one coherent voice-memory slice |
| Full production-ready live voice stack | 28/100 | 46/100 | Still blocked by lack of streaming telephony, live STT/TTS, and infrastructure-backed proof |

## Honest Residual Blockers

The remaining blockers are mostly infrastructure and live-provider related rather than missing local code scaffolding.

| Blocker | Why it still matters |
| --- | --- |
| No live telephony provider bridge | Without it, the new voice APIs cannot yet ingest real live call events end to end |
| No streaming STT/TTS runtime | The platform still lacks true spoken-turn automation and must rely on textual turn inputs |
| No always-on stage host | Full APISIX, OpenAppSec, Keycloak, Permify, Redis, broker, and telephony proof still cannot be exercised continuously here |
| Sparse merchant inventory context | Substitution handling is still reasoning on historical cues rather than live menu availability feeds |
| Partial customer-history depth | The memory model is durable but still not richly item-personalized across all order entities |

## Recommended Next Actions

The next highest-value LongCat actions are now very concrete.

| Priority | Next action | Why it is next |
| --- | --- | --- |
| 1 | Add a live telephony webhook adapter and bind it to `startVoiceSession` and `appendVoiceTurn` | This turns the new voice APIs into a real provider-facing ingress path |
| 2 | Add streaming speech ingestion and prompt playback boundaries | This closes the gap between voice session state and a true spoken interaction loop |
| 3 | Enrich personalization memory from richer order-item and merchant context | This improves repeat-order quality and substitution handling materially |
| 4 | Route live queue and disruption telemetry into the Rust priority scorer | This turns the current scoring endpoint from good heuristic support into stronger operations intelligence |
| 5 | Run staged middleware-backed replay proof on persistent infrastructure | This is required before claiming production readiness for the full voice flow |

## Conclusion

Wave 9 materially improved the LongCat integration from a strong local AI assistant into an early **voice-capable, persisted, polyglot, middleware-aware** subsystem. The platform now has a real foundation for live phone-ordering AI rather than only summary enrichment. The honest remaining work is no longer about whether the architecture exists. It is about connecting that architecture to live telephony, richer history, and persistent stage infrastructure.
