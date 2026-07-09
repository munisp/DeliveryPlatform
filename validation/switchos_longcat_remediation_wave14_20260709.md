# SwitchOS LongCat Remediation Wave 14

**Author:** Manus AI  
**Date:** 2026-07-09

## Executive Summary

Wave 14 focused on the **next highest-value LongCat voice hardening gap that was still locally closable after wave 13**: the platform needed explicit **speech-engine readiness signaling** and **honest upstream error propagation** between the Python speech runtime, the Go PBX-facing gateway, and the TypeScript LongCat core. Without that work, degraded speech execution could still look ambiguous to operators, and upstream lifecycle conflicts could still be flattened into generic failures at the gateway boundary.

This wave closes that gap in two practical ways. First, the Python speech runtime now reports **structured STT and TTS readiness state**, including `engine_ready` and `degraded_reason` fields at the result level and explicit per-engine readiness details in `/health`. Second, the Go voice gateway now preserves **upstream HTTP failure semantics**, including clean **HTTP 409 conflict propagation** and stream termination when a terminal LongCat session rejects late or replayed transcript traffic.

The result is a materially stronger contract across the self-hosted voice stack. The platform can now distinguish between **engine-not-ready degraded execution**, **normal contract execution**, and **terminal-session replay rejection**, which improves PBX safety, retry correctness, operator visibility, and future middleware observability.

## Four-Phase Execution Status

Wave 14 followed the four recommended action phases from the prior report, but only the locally provable subset was executable inside this sandbox.

| Phase | Scope | Status | Outcome |
| --- | --- | --- | --- |
| **Phase 1** | Reassess the post-wave 13 voice, PBX, and speech-runtime gap set | **Completed** | Confirmed that the highest remaining local risk was ambiguous speech degradation and flattened upstream conflict semantics. |
| **Phase 2** | Implement local hardening in Python and Go | **Completed** | Added readiness helpers and structured engine metadata in Python; added upstream status-aware forwarding and terminal conflict handling in Go. |
| **Phase 3** | Deepen validation and contract coverage | **Completed** | Added focused Go and Python tests for conflict propagation and degraded engine signaling; reran LongCat regression coverage. |
| **Phase 4** | Publish report and prepare commit/push | **Completed locally** | Report written and code ready for Git commit and push. Persistent infrastructure proof remains outside sandbox scope. |

## What Was Implemented

| Area | Change | Why it matters |
| --- | --- | --- |
| **Python speech runtime** | Added `resolve_stt_runtime()`, `resolve_tts_runtime()`, and `resolve_whisper_cpp_binary()` in `services/python/speech-runtime/main.py`. | The runtime now reports whether self-hosted STT and TTS engines are actually executable instead of implying availability. |
| **Speech health surface** | `/health` now returns `stt_ready`, `tts_ready`, `stt_runtime`, `tts_runtime`, and `stream_timeout_seconds`. | Operators and future probes can distinguish between healthy HTTP service reachability and true speech-engine readiness. |
| **Speech result contract** | STT and TTS payloads now include `engine_ready` and `degraded_reason`, alongside existing degraded-mode indicators. | Downstream LongCat callers can react differently to intentional degradation versus a normal engine-backed path. |
| **Go gateway forwarding semantics** | Added `HTTPStatusError`, `isHTTPStatus()`, and `respondForwardingError()` in `services/go/voice-gateway/main.go`. | The gateway now preserves real upstream HTTP semantics instead of collapsing them into generic bad-gateway style failures. |
| **PBX replay stop behavior** | AudioSocket frame handling now treats upstream **409 Conflict** as a terminal session barrier and stops stream ingestion cleanly. | Late STT segments and replayed PBX packets no longer look like generic gateway failures after a call is already terminal. |
| **Focused validation** | Added `services/go/voice-gateway/main_test.go` and `services/python/speech-runtime/test_main.py`. | Wave 14 is backed by executable proof for both degraded speech signaling and terminal conflict handling. |

## Detailed Implementation Notes

### 1. Explicit Engine-Readiness Semantics in the Python Speech Runtime

Before this wave, the speech runtime already exposed self-hosted STT and TTS endpoints, but the contract still left too much ambiguity when the real engines were absent. A caller could tell that execution was degraded, but it could not distinguish clearly between a **reachable runtime process** and a **truly ready backend engine**.

That ambiguity is now reduced materially. The runtime resolves configured engines into structured readiness objects and surfaces them consistently both at the service-health layer and in request-level responses.

| Contract surface | New fields or behavior | Operational effect |
| --- | --- | --- |
| `/health` | `stt_ready`, `tts_ready`, `stt_runtime`, `tts_runtime` | Enables operator checks and future probes to distinguish process health from engine readiness. |
| `/stt/transcribe`, `/stt/stream-chunk`, `/ws/stt` | `engine_ready`, `degraded_reason` | Distinguishes empty or hint-driven transcript behavior from a fully provisioned STT backend. |
| `/tts/synthesize`, `/ws/tts` | `engine_ready`, `degraded_reason` | Distinguishes a fallback playback-text response from a real Piper-backed synthesis path. |

This matters because the sandbox still lacks a persistent, installed production STT and TTS stack. The code can now state that limitation **honestly and machine-readably** instead of leaving downstream systems to infer it from generic errors.

### 2. Honest Upstream HTTP Status Propagation in the Go Voice Gateway

The next important gap was in the Go PBX-facing gateway. Even after wave 13 introduced `409 Conflict` semantics at the TypeScript core boundary, the gateway could still flatten those statuses during forwarding, which meant a terminal-session replay could still appear as a vague transport failure to upstream callers or PBX flow control.

That forwarding path is now hardened.

| Gateway path | Previous posture | Current posture |
| --- | --- | --- |
| Bootstrap forwarding | Upstream failures could be reduced to a generic forwarding error | Upstream status and JSON body are preserved when possible |
| Transcript forwarding | Terminal-session conflicts were not preserved clearly | **409** is preserved and forwarded honestly |
| AudioSocket live stream loop | Conflict on replayed transcript could look like a generic frame-processing failure | **409** now becomes a clean terminal-session stop condition |

This is especially important in PBX-style deployments because late packets, duplicated transport retries, or delayed STT final segments are normal edge cases in telephony systems. The gateway now treats those as **lifecycle conflicts** rather than as misleading application faults.

### 3. Targeted Contract Coverage for the New Failure Modes

Wave 14 also adds focused tests so the new behavior is not only documented but executable.

| Test surface | File | Verified behavior |
| --- | --- | --- |
| LongCat regression coverage | `tests/longcat.integration.test.ts` | Existing terminal-session and callback-safety protections still pass after wave 14 changes. |
| Go gateway forwarding | `services/go/voice-gateway/main_test.go` | Preserves upstream JSON error bodies and recognizes HTTP status-specific forwarding errors. |
| Go PBX stop behavior | `services/go/voice-gateway/main_test.go` | Returns `errTerminalSessionConflict` when STT output hits a terminal-session transcript conflict. |
| Python speech readiness | `services/python/speech-runtime/test_main.py` | Degraded STT and TTS responses expose `engine_ready` and `degraded_reason` honestly. |

## Validation Evidence

The following targeted validation was executed after the wave 14 changes.

| Validation target | Result | Evidence |
| --- | --- | --- |
| `npx vitest run tests/longcat.integration.test.ts` | **Passed** | 5 LongCat regression tests passed. |
| `go build ./...` in `services/go/voice-gateway` | **Passed** | Confirms the Go PBX-facing gateway compiles after the forwarding and conflict-handling changes. |
| `python3 -m py_compile services/python/speech-runtime/main.py` | **Passed** | Confirms the Python speech runtime remains syntactically valid after the readiness helper changes. |
| `npm run build` | **Passed** | Production client build and server bundle completed successfully. |
| `go test ./...` in `services/go/voice-gateway` | **Passed** | New focused gateway contract suite passed. |
| `python3 -m unittest -v test_main.py` in `services/python/speech-runtime` | **Passed** | New speech-runtime readiness contract tests passed. |

## Updated Production-Readiness Scores

These scores remain **honest readiness estimates**, not claims of full production proof. They reflect the current code posture after wave 14, while preserving the distinction between local hardening and infrastructure-backed validation.

| Component | Previous posture | Current score | Rationale |
| --- | --- | --- | --- |
| **LongCat voice lifecycle integrity** | Strong local lifecycle barriers after wave 13 | **8.2 / 10** | Session replay rejection now extends more coherently through gateway behavior. |
| **Go PBX-facing gateway contract honesty** | Functional ingress, but upstream status flattening remained | **7.6 / 10** | Upstream conflicts and JSON error semantics are now preserved and PBX stream stop behavior is clearer. |
| **Python speech runtime contract honesty** | Degraded mode existed, but engine readiness was still ambiguous | **7.4 / 10** | Engine readiness is now explicit, but real streaming engines are still not installed here. |
| **Operator visibility for speech degradation** | Partial visibility through degraded-mode responses | **7.0 / 10** | Health and result contracts are materially better, but no full operator dashboard surface was added in this wave. |
| **End-to-end live telephony proof** | Infrastructure-blocked | **4.1 / 10** | Contract readiness improved, but no live PBX call proof exists in this sandbox. |
| **End-to-end real STT/TTS proof** | Engine-blocked | **3.8 / 10** | The contract is better, but no installed faster-whisper or whisper.cpp model path and no Piper voice assets were exercised live. |
| **Full middleware-backed stage proof** | Persistent stage-blocked | **4.5 / 10** | Code remains integration-aware, but the all-services stage remains unproven locally. |

## Remaining Gaps and Honest Blockers

Wave 14 improves the local contract layer, but the dominant remaining blockers are still **infrastructure-bound rather than code-structure-bound**.

### A. Live PBX Execution

| Remaining blocker | Why it still matters |
| --- | --- |
| **Persistent Asterisk deployment with AudioSocket dialplan** | The Go gateway is more honest and safer, but there is still no always-on PBX in this sandbox to prove a real call path. |
| **Live media ingress and disconnect cadence** | Clean stop behavior is now coded and tested, but it still needs validation against real PBX packet timing and disconnect behavior. |
| **Stable host networking** | Real voice ingress requires persistent reachability and uptime beyond sandbox lifecycle constraints. |

### B. Real Self-Hosted Speech Engines

| Remaining blocker | Why it still matters |
| --- | --- |
| **Installed STT backend with model assets** | `resolve_stt_runtime()` can now state readiness honestly, but no production STT binary or model path has been exercised here. |
| **Installed Piper binary and voice model** | The TTS contract is clearer, but real synthesized audio still depends on provisioning Piper in a persistent environment. |
| **Latency and buffering proof under real audio cadence** | This still requires sustained live stream traffic from PBX ingress, not sandbox-only synthetic requests. |

### C. Full Middleware-Backed Stage Proof

| Remaining blocker | Why it still matters |
| --- | --- |
| **APISIX and OpenAppSec ingress path** | Voice ingress is not yet proven through the full stage gateway and security chain. |
| **Redis, Kafka, Dapr, Fluvio, OpenSearch, and lakehouse correlation** | Event sinks and analytics hooks exist, but live evidence across the whole middleware path is still missing. |
| **Keycloak, Permify, Temporal, Mojaloop, and TigerBeetle stage execution** | Broader production proof requires a durable environment with the full platform topology online together. |

## Recommended Next Actions

The next steps remain the same in direction, but wave 14 narrows their scope more precisely.

| Priority | Next action | Reason |
| --- | --- | --- |
| **1** | Move the PBX, Go gateway, Python speech runtime, and LongCat core onto a **persistent host**. | Persistent infrastructure is now the dominant blocker to real telephony proof. |
| **2** | Install a real **faster-whisper** or **whisper.cpp** runtime and validated model assets. | The runtime can now report readiness honestly, but it still needs a real STT backend to leave degraded mode. |
| **3** | Install **Piper** and a validated production voice model. | The TTS path remains contract-ready but asset-bound. |
| **4** | Connect **Asterisk AudioSocket** to the Go voice gateway and capture a full voice-ordering proof. | This closes the live call ingress gap and validates late-packet conflict handling on real traffic. |
| **5** | Run a durable stage proof through **APISIX**, **Redis**, **PostgreSQL**, **Permify**, **OpenSearch**, one enabled event bus, and analytics sinks. | This closes the middleware-backed production proof gap. |

## Bottom Line

Wave 14 delivers a meaningful local production-hardening improvement for the LongCat voice stack. The Python speech runtime now states **whether its engines are actually ready**, and the Go PBX-facing gateway now preserves **real upstream lifecycle conflict semantics** instead of flattening them into generic failures.

That means the platform is now better at telling the truth about three distinct operational states: **normal engine-backed execution**, **degraded engine-unavailable execution**, and **terminal-session replay conflict**. The remaining work is still substantial, but it is increasingly about **persistent infrastructure and real engine activation**, not about missing local contract safety in the codebase.
