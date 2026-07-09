# SwitchOS LongCat Remediation Wave 15

**Author:** Manus AI  
**Date:** 2026-07-09

## Executive Summary

After wave 14, the most important remaining **locally provable** next action was not to pretend that persistent PBX and speech-engine deployment had already been achieved, but to continue extending **honest readiness and degradation telemetry** through the layers that already exist in the sandbox. Wave 15 therefore focused on the next highest-value code path: ensuring that speech-runtime readiness signals and telephony degradation semantics reach the **TypeScript orchestration layer**, the **operator probe surface**, and the **PBX-facing gateway contract** in a form that can be validated automatically.

This wave implemented three linked improvements. First, the TypeScript LongCat voice core now preserves and records **engine readiness** and **degraded reason** signals for both STT-ingress and TTS-egress flows. Second, the Go voice gateway now forwards **STT readiness metadata** from the Python speech runtime into transcript submissions, allowing the orchestration layer to distinguish a valid-but-degraded transcript from a fully provisioned speech path. Third, the operator integration probe layer now includes **LongCat voice-gateway** and **LongCat speech-runtime** checks, with the speech-runtime probe treating "HTTP up but no engines ready" as an honest degraded state rather than a misleading healthy one.

Wave 15 does not claim that live PBX ingress, Piper synthesis, or real whisper-based streaming STT are fully proven end to end inside this sandbox. Instead, it materially improves the platform’s ability to **tell the truth about those remaining gaps**, which is the highest-value next action that was actually feasible to implement and validate locally.

## Four-Phase Execution Status

| Phase | Scope | Status | Outcome |
| --- | --- | --- | --- |
| **Phase 1** | Re-read the execution skills and reassess feasibility | **Completed** | Confirmed that live PBX, installed speech engines, and full multi-middleware stage proof remain infrastructure-bound, while operator-visibility and contract-propagation work remain locally feasible. |
| **Phase 2** | Inspect the current code frontier after wave 14 | **Completed** | Identified the highest-value remaining local gap: wave 14 readiness signals stopped at the Python and Go boundaries and were not fully propagated into TypeScript telemetry or probe surfaces. |
| **Phase 3** | Implement the next local hardening and validation | **Completed** | Added STT/TTS readiness propagation, operator probes for LongCat services, and focused test coverage in Go and TypeScript. |
| **Phase 4** | Validate, document, and prepare Git delivery | **Completed locally** | Validation passed, remediation report written, and the repository is ready for the next Git commit and push. |

## What Was Implemented

| Area | Change | Why it matters |
| --- | --- | --- |
| **TypeScript LongCat voice core** | Extended `LongCatSpeechSynthesisResult` in `server/_core/longcatVoice.ts` to include `engine_ready` and `degraded_reason`. | The main orchestration layer now preserves speech-runtime honesty instead of collapsing it into a single degraded boolean. |
| **TTS telemetry persistence** | `synthesizeLongCatSpeech()` now parses readiness and degraded-reason fields from the Python speech runtime and records them into speech-event metadata. | Operators and downstream event consumers can distinguish unreachable runtime failures from installed-engine absence or other degraded causes. |
| **STT ingress telemetry propagation** | `appendLongCatTelephonyTranscript()` now reads `stt_engine`, `stt_engine_ready`, `stt_degraded_mode`, `stt_degraded_reason`, and `stt_latency_ms` from transcript metadata and records them in ingress speech events. | The LongCat core can now preserve what the gateway learned from the speech runtime instead of hardcoding ingress STT as healthy. |
| **Operator safety visibility** | Added `longcat.voice.telephony_turn_processed` operational events with STT and TTS readiness, degradation, latency, transport, and callback-intent fields. | This creates a richer operator-visible lifecycle surface through the existing PostgreSQL, Dapr, and OpenSearch event bridge. |
| **Go PBX-facing gateway** | Extended `SpeechChunkResponse` in `services/go/voice-gateway/main.go` and forwarded STT readiness and degraded-reason metadata into transcript requests. | The gateway now preserves more than transcript text; it forwards speech-runtime condition signals alongside the content. |
| **Integration probe layer** | Added `probeLongCatVoiceGateway()` and `probeLongCatSpeechRuntime()` in `server/_core/integrationProbes.ts`, and included both in `getLiveIntegrationStatus()`. | The operator status surface now covers the LongCat voice stack explicitly rather than only the surrounding middleware. |
| **Focused automated validation** | Extended `tests/integration-probes.test.ts` and `services/go/voice-gateway/main_test.go`. | Wave 15 is backed by executable proof for readiness propagation and honest operator-visible degradation semantics. |

## Detailed Implementation Notes

### 1. Speech-Engine Honesty Now Reaches the TypeScript LongCat Layer

Wave 14 made the Python speech runtime and the Go gateway more explicit, but the TypeScript orchestration layer still behaved as though ingress STT was effectively healthy unless something failed catastrophically. That meant the platform had better signals at the edge, yet still lost them before they became durable telemetry.

Wave 15 closes most of that gap.

| Speech path | Previous posture | Current posture |
| --- | --- | --- |
| **TTS egress** | Preserved `degraded_mode` and generic error only | Preserves `engine_ready` and `degraded_reason` alongside latency and engine metadata |
| **STT ingress** | Recorded the configured STT engine and hardcoded `degradedMode: false` | Records readiness, degraded mode, degraded reason, and latency from gateway-forwarded metadata |
| **Operational event layer** | Did not emit turn-level readiness detail | Emits a turn-processed event with STT and TTS condition fields |

This is important because it turns degraded speech execution into a **first-class observable condition** rather than a silent assumption that only exists in the speech runtime logs or the gateway boundary.

### 2. The Go Gateway Now Forwards More Than Text

The PBX-facing gateway previously forwarded transcript text and a small amount of metadata, but it still did not fully preserve the richer speech-runtime contract introduced in wave 14. That meant the TypeScript core could receive a transcript that originated from a degraded STT path without knowing whether the engine was truly ready.

Wave 15 extends that contract.

| Field class | Newly forwarded from Go gateway |
| --- | --- |
| **Engine identity** | `stt_engine` |
| **Readiness state** | `stt_engine_ready` |
| **Degradation state** | `stt_degraded`, `stt_degraded_mode`, `stt_degraded_reason` |
| **Latency context** | `stt_latency_ms` |
| **Audio correlation** | `audio_chunk_id`, `audio_bytes` |

This matters operationally because transcript text alone is not enough to reason about production behavior in a self-hosted speech stack. The orchestration layer now receives the **condition of the STT path**, not just its textual output.

### 3. Operator Integration Status Now Includes LongCat Voice and Speech Services

The existing probe layer already covered APISIX, OIDC, Permify, Redis, Dapr, OpenSearch, Temporal, Fluvio, Mojaloop, TigerBeetle, lakehouse, and related services. However, it still lacked explicit LongCat voice-stack probes, which meant the operator status surface omitted the very services at the center of the current remediation program.

Wave 15 adds those surfaces and makes the speech-runtime probe more honest than a simple HTTP check.

| Probe | Healthy behavior | Degraded behavior |
| --- | --- | --- |
| **LongCat voice gateway** | `/health` returns an OK-like status and exposes gateway wiring details | Non-OK response or fetch failure returns degraded |
| **LongCat speech runtime** | `/health` returns `healthy` and at least one engine is ready | Reports degraded if the service says `degraded` or if both STT and TTS engines are not ready |

This makes operator visibility better aligned with the actual remediation frontier. A runtime that answers HTTP but cannot perform either STT or TTS should not be represented as healthy.

## Validation Evidence

The following targeted validation was executed after the wave 15 changes.

| Validation target | Result | Evidence |
| --- | --- | --- |
| `npx vitest run tests/integration-probes.test.ts tests/longcat.integration.test.ts` | **Passed** | 9 tests passed across operator-probe and LongCat regression coverage. |
| `go test ./...` in `services/go/voice-gateway` | **Passed** | Gateway tests passed, including the new STT readiness metadata forwarding assertion. |
| `go build ./...` in `services/go/voice-gateway` | **Passed** | Confirms the Go PBX-facing gateway still compiles after the richer speech contract propagation. |
| `python3 -m py_compile services/python/speech-runtime/main.py` | **Passed** | Confirms the Python speech runtime remains syntactically valid after wave 14 and wave 15 contract coupling. |
| `python3 -m unittest -v test_main.py` in `services/python/speech-runtime` | **Passed** | Speech-runtime readiness tests still pass after the broader stack propagation work. |
| `npm run build` | **Passed** | Production client build and server bundle completed successfully. |

## Updated Production-Readiness Scores

These scores remain **honest engineering estimates**, not proof of full production deployment.

| Component | Previous posture | Current score | Rationale |
| --- | --- | --- | --- |
| **LongCat voice lifecycle integrity** | Strong local lifecycle safety after waves 13 and 14 | **8.4 / 10** | Replay rejection, conflict propagation, and richer speech-condition telemetry are now more coherent end to end. |
| **Go PBX-facing gateway contract honesty** | Good upstream error semantics, partial speech-condition propagation | **8.0 / 10** | The gateway now carries STT readiness and degraded-reason signals into the orchestration boundary. |
| **Python speech runtime contract honesty** | Strong self-reporting at the runtime layer | **7.5 / 10** | The runtime contract remains solid and is now actually consumed downstream instead of being partially dropped. |
| **Operator visibility for degraded LongCat voice execution** | Moderate visibility through health and degraded-mode signals | **7.8 / 10** | The platform now probes LongCat voice services directly and emits turn-level readiness telemetry. |
| **End-to-end live telephony proof** | Still infrastructure-blocked | **4.2 / 10** | The contracts are better wired, but there is still no persistent PBX call proof inside this sandbox. |
| **End-to-end real STT/TTS proof** | Still engine-blocked | **4.0 / 10** | Readiness honesty improved, but real whisper- or Piper-backed execution is still not demonstrated here. |
| **Full middleware-backed stage proof** | Persistent stage-blocked | **4.7 / 10** | More telemetry is now ready for stage proof, but the stage itself is still not online in this environment. |

## Remaining Gaps and Honest Blockers

Wave 15 improves the observability and contract-propagation frontier, but the next blockers are still mostly external to this sandbox.

### A. Persistent PBX and Telephony Infrastructure

| Remaining blocker | Why it still matters |
| --- | --- |
| **Always-on Asterisk or FreeSWITCH deployment** | The gateway and core are better instrumented, but real voice ingress still requires a persistent PBX host and dialplan. |
| **Live disconnect, retry, and jitter behavior** | Replay safety and degraded-mode telemetry are now coded, but they still need proof under real network cadence and PBX behavior. |
| **Stable network and service uptime** | A real phone-ordering ingress path cannot be proven with a hibernating sandbox alone. |

### B. Real Self-Hosted Speech Engines

| Remaining blocker | Why it still matters |
| --- | --- |
| **Installed whisper-compatible STT runtime and model assets** | The platform can now report missing readiness honestly, but it still needs the real engine to leave degraded mode. |
| **Installed Piper binary and production voice model** | TTS remains contract-ready and telemetry-rich, but not fully exercised with real local synthesis assets here. |
| **Sustained latency and buffering proof** | This requires actual audio cadence, not only synthetic request-level validation. |

### C. Full Stage Middleware Bring-Up

| Remaining blocker | Why it still matters |
| --- | --- |
| **APISIX and OpenAppSec in front of LongCat voice ingress** | The voice path still is not proven through the real ingress-security layer. |
| **Redis, Kafka, Dapr, Fluvio, OpenSearch, and lakehouse under one persistent run** | The event hooks and telemetry are better, but the cross-middleware staged proof is still absent in this sandbox. |
| **Keycloak, Permify, Temporal, Mojaloop, and TigerBeetle together in stage topology** | Broader production readiness still depends on a durable all-services environment. |

## Recommended Next Actions After Wave 15

| Priority | Next action | Reason |
| --- | --- | --- |
| **1** | Move the LongCat voice stack to a **persistent host** that can run PBX, Node, Go, Python, Redis, and PostgreSQL continuously. | Persistent infrastructure is still the main blocker class. |
| **2** | Install a real **whisper-compatible STT backend** and verified model assets. | The platform now reports STT unreadiness honestly and is ready for real engine activation. |
| **3** | Install **Piper** with a validated production voice model and exercise real synthesis. | TTS readiness and degradation telemetry are now wired through the stack; the next step is real engine proof. |
| **4** | Connect a live **Asterisk AudioSocket** dialplan to the Go voice gateway and capture a real voice-ordering trace. | This closes the live PBX ingress gap and validates the newly improved telemetry under real traffic. |
| **5** | Bring up the **full middleware stage** on Docker-capable or persistent infrastructure and run a correlated proof across APISIX, Permify, Redis, PostgreSQL, OpenSearch, and enabled event buses. | The local code frontier is now sufficiently instrumented to justify a broader staged proof run. |

## Bottom Line

Wave 15 continues implementing the recommended next actions honestly. It does not fabricate PBX or speech-engine proof that this sandbox cannot provide. Instead, it advances the highest-value remaining local work by ensuring that **speech readiness, degraded reasons, and turn-level telephony condition signals now survive across Python, Go, TypeScript, and the operator probe layer**.

That means the platform is now better prepared for the next real milestone: moving from **code-level honesty and local validation** into **persistent infrastructure proof** with live PBX ingress, installed open-source speech engines, and the full middleware stack online together.
