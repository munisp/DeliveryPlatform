# SwitchOS LongCat Remediation Wave 12 — Session Closure and Callback-Safety Hardening

**Author:** Manus AI  
**Date:** 2026-07-09

## Executive Summary

This remediation wave focused on the **highest-value remaining LongCat gaps that were still feasible inside the current sandbox** after the PBX-ingress and streaming-speech scaffolding from wave 11. The most important unresolved local issues were that protocol-native telephony sessions could remain open indefinitely after ingress disconnects, and outbound callback escalation could still be triggered too aggressively from ambiguous conversational signals. I closed both of those gaps.

In this wave, I added a **durable telephony-ingress close lifecycle** in the TypeScript LongCat core, exposed a new **internal close route** on the Node service, and extended the **Go AudioSocket-style voice gateway** so it automatically finalizes telephony sessions when PBX streams disconnect or fail. I also hardened the **callback action boundary** so LongCat now only auto-dispatches callback escalation when there is explicit customer phrasing, explicit operator/system metadata approval, or a system-driven path that is already marked safe.

The targeted validation passed. The focused LongCat Vitest suite passed, the production build passed, the Go voice gateway built successfully, and the Python speech runtime compiled successfully. At this point, the dominant remaining blockers are honestly **infrastructure and engine blockers**, not missing local safety or lifecycle code.

## What Was Implemented

| Area | Change | Why it matters |
| --- | --- | --- |
| **TypeScript LongCat core** | Added `closeLongCatTelephonyIngressSession()` in `server/_core/longcatVoice.ts`. | Telephony ingress sessions now have a clean persisted close path instead of remaining implicitly active forever. |
| **Node internal service surface** | Added `/api/internal/longcat/voice/close` to `server/_core/index.ts`. | PBX-facing services now have an authenticated lifecycle route to finalize LongCat sessions and persist closure state. |
| **Go voice gateway** | Extended `services/go/voice-gateway/main.go` so AudioSocket-style connections call the new close route on EOF and failure paths. | Live PBX ingress no longer leaves orphaned active sessions on disconnect, timeout, or frame-handling failure. |
| **Action safety boundary** | Added `shouldAllowAutomaticCallbackDispatch()` and enforced callback confirmation gating in `server/_core/longcatVoice.ts`. | LongCat no longer auto-dispatches voice callback escalation merely because the model or transcript vaguely suggests follow-up. |
| **Automated validation** | Extended `tests/longcat.integration.test.ts` with focused callback-safety coverage. | The new safety boundary is backed by an executable test rather than only a code comment or report claim. |

## Detailed Implementation Notes

### 1. Durable Telephony Session Closure

The new closure path addresses a concrete lifecycle gap: after the wave 11 AudioSocket-style ingress work, the gateway could bootstrap sessions and forward transcripts, but it had no explicit **end-of-call finalization** behavior. That meant real PBX disconnects would leave LongCat session state looking active unless an external operator or later workflow corrected it.

The new TypeScript close helper now performs the following actions in a single lifecycle path:

| Closure behavior | Result |
| --- | --- |
| Updates `longcat_voice_ingress_sessions` | Marks ingress rows as `completed`, `failed`, or `abandoned`, and stores close metadata. |
| Updates `longcat_voice_sessions` | Marks the higher-level voice session closed and records the closure context. |
| Records a speech lifecycle event | Persists `telephony_session_closed` into the speech-event trail. |
| Ingests lifecycle rows to lakehouse | Preserves closure events for analytics and replay. |
| Emits an operational event | Makes close behavior visible to the middleware-backed event layer. |

### 2. AudioSocket Disconnect Handling in Go

The Go voice gateway now treats connection termination as a real lifecycle event rather than a silent return path. The new behavior is that:

| Disconnect scenario | Gateway behavior |
| --- | --- |
| **Normal EOF** | Marks the session `completed` and calls the Node close route. |
| **Read error / transport failure** | Marks the session `failed`, stores the transport error in the close reason, and calls the Node close route. |
| **Frame-handling failure** | Marks the session `failed` and closes the session with chunk-count metadata. |

This is materially closer to what a real PBX ingress service should do in production, because **session lifecycle is now explicit and replayable** rather than inferred from missing traffic.

### 3. Callback-Safety Hardening

The second major local gap was **action safety**. Prior to this wave, callback escalation could be requested whenever the model suggested it or when ambiguous phrases were interpreted too broadly. That is not a safe default for a production voice assistant.

The new helper `shouldAllowAutomaticCallbackDispatch()` now limits automatic callback dispatch to the following explicit cases:

| Allowed auto-dispatch case | Rule |
| --- | --- |
| **Explicit customer callback phrasing** | Phrases like “call me back” or “please ring me” are treated as affirmative customer intent. |
| **Explicit operator/system approval** | `allow_callback_dispatch` in metadata can authorize dispatch from a trusted upstream flow. |
| **System-originated turn** | A system-driven turn can dispatch when the surrounding workflow is already operating inside a controlled action path. |

If callback intent is detected but not safely authorized, LongCat now **does not dispatch automatically**. Instead, it inserts a next action instructing the operator to confirm callback consent explicitly first, and the callback dispatch result reports `operator_confirmation_required` instead of pretending the escalation happened.

## Validation Evidence

The following targeted validation was executed after the new changes:

| Validation target | Result | Evidence |
| --- | --- | --- |
| `npx vitest run tests/longcat.integration.test.ts` | **Passed** | 4 tests passed, including the new callback-safety case. |
| `npm run build` | **Passed** | Production Vite + esbuild build completed successfully. |
| `go build ./...` in `services/go/voice-gateway` | **Passed** | The new PBX close-lifecycle logic compiled successfully. |
| `python3 -m py_compile services/python/speech-runtime/main.py` | **Passed** | Confirms the Python speech runtime remains syntactically valid after prior streaming work. |

## Readiness Impact

| Component | Previous posture | Current posture | Readiness impact |
| --- | --- | --- | --- |
| **LongCat telephony ingress** | Could bootstrap and stream transcripts, but lacked explicit disconnect closure | Now has **explicit PBX session close lifecycle** via Go → Node → PostgreSQL | **Improved materially** |
| **LongCat action safety** | Callback escalation could still be over-eager on ambiguous signals | Auto-dispatch now requires **explicit callback consent or trusted metadata** | **Improved materially** |
| **Operational traceability** | Session closure was implied rather than recorded | Close state now produces persisted lifecycle and operational evidence | **Improved materially** |
| **Streaming speech runtime** | Already had streaming contract surfaces from wave 11 | Unchanged in code this wave; still blocked by real engine installation for full proof | **No direct delta** |
| **Persistent stage middleware proof** | Still blocked by environment | Still blocked by environment | **No direct delta** |

## Remaining Gaps and Honest Blockers

The remaining blockers are now predominantly **outside the sandbox’s local code-repair frontier**.

### A. Live PBX Infrastructure

| Remaining blocker | Why it still matters |
| --- | --- |
| **Real Asterisk or FreeSWITCH deployment** | The Go gateway now speaks a protocol-native ingress shape, but there is still no running PBX here to prove live call handling. |
| **Dialplan / extension routing** | No live call-routing fabric is connected to the gateway. |
| **Persistent host and reachable network path** | Real telephony ingress requires stable uptime and addressing beyond the sandbox lifecycle. |

### B. Real Streaming STT and TTS Engines

| Remaining blocker | Why it still matters |
| --- | --- |
| **Installed streaming STT backend** | The Python runtime still degrades unless a real engine is installed. |
| **Installed Piper binary and production voice model** | TTS remains contract-ready but engine-blocked until the runtime has real voice assets. |
| **Runtime audio buffering and resampling proof** | This needs real media cadence and real engine latency under live traffic. |

### C. Persistent Stage Middleware Proof

| Remaining blocker | Why it still matters |
| --- | --- |
| **APISIX / OpenAppSec live path** | End-to-end ingress still lacks proof through the real gateway layer. |
| **Redis / PostgreSQL / Kafka / Dapr / Fluvio / OpenSearch** | The LongCat operational event flow is code-ready, but persistent integrated replay is still environment-bound. |
| **Keycloak / Permify / Temporal / Mojaloop / TigerBeetle / lakehouse** | Broader platform-wide proof still requires a persistent stage topology, not more sandbox-only scaffolding. |

## Detailed Plan for the Remaining Recommended Next Actions

The next plan should focus on **persistent infrastructure bring-up and real engine installation**, because that is now the main blocker class.

### Phase 1 — Live PBX Bring-Up

| Step | Action | Primary stack |
| --- | --- | --- |
| **1.1** | Provision a persistent Docker-capable or VM-based host for PBX, Redis, PostgreSQL, gateway, and speech runtime. | Infrastructure |
| **1.2** | Deploy **Asterisk** with AudioSocket-enabled dialplan or **FreeSWITCH** with an equivalent media bridge. | PBX |
| **1.3** | Point the PBX media path at `services/go/voice-gateway` and verify call UUID, DTMF, and PCM framing. | **Go** |
| **1.4** | Verify session bootstrap, transcript append, and session close through the Node internal LongCat routes. | **TypeScript** |
| **1.5** | Capture end-to-end lifecycle evidence into PostgreSQL, lakehouse, and operational events. | **TypeScript** + **Python** |

### Phase 2 — Streaming Speech Engine Installation

| Step | Action | Primary stack |
| --- | --- | --- |
| **2.1** | Install a self-hosted streaming STT backend compatible with faster-whisper-style transcription. | **Python** |
| **2.2** | Install **Piper** plus validated production voice models. | **Python** |
| **2.3** | Add real resampling, buffering, and partial/final transcript semantics for live media cadence. | **Go** + **Python** |
| **2.4** | Extend transcript payloads with confidence and partial/final metadata. | **Python** + **TypeScript** |
| **2.5** | Measure latency budgets under sustained session load and tighten degraded-mode signaling. | **Go** + **Python** |

### Phase 3 — Persistent Stage Middleware Proof

| Step | Action | Middleware / services |
| --- | --- | --- |
| **3.1** | Route LongCat ingress through **APISIX** and, where enabled, **OpenAppSec**. | APISIX, OpenAppSec |
| **3.2** | Enforce service and operator identity through **Keycloak** and **Permify**. | Keycloak, Permify |
| **3.3** | Publish voice lifecycle events through the enabled event bus (**Kafka**, **Dapr**, or **Fluvio**). | Kafka, Dapr, Fluvio |
| **3.4** | Persist searchable operations artifacts into **OpenSearch** and analytics into the **lakehouse**. | OpenSearch, lakehouse |
| **3.5** | Exercise Temporal- and finance-adjacent action flows where LongCat initiates downstream operations. | Temporal, Mojaloop, TigerBeetle |

## Recommended Next Actions

| Priority | Next action | Reason |
| --- | --- | --- |
| **1** | Move the LongCat PBX and speech stack to a **persistent host**. | This is now the main blocker to honest live proof. |
| **2** | Install a real **streaming STT engine** and **Piper voice model**. | The runtime interfaces exist; the engines do not. |
| **3** | Connect the Go voice gateway to a live **Asterisk or FreeSWITCH** dialplan. | This is required for real telephony ingress validation. |
| **4** | Run an end-to-end middleware-backed replay through **APISIX**, **Redis**, **PostgreSQL**, **OpenSearch**, and one enabled event bus. | This closes the persistent stage proof gap. |
| **5** | Add deeper automated contract coverage for telephony close events and speech-runtime degradation modes. | The next validation frontier is runtime contract depth, not basic compile health. |

## Bottom Line

This wave closed the most important **remaining local safety and lifecycle gaps** in the LongCat voice stack. The PBX ingress path now has an explicit close lifecycle, and callback escalation is no longer allowed to act too aggressively on ambiguous signals. Those are meaningful production-hardening improvements.

The remaining blockers are now honestly the ones that require **persistent infrastructure and real engines**: a live PBX, installed streaming STT/TTS runtimes, and a full middleware-backed stage environment for end-to-end proof. Within the sandbox, the most valuable remaining work has shifted from structural code repair to infrastructure-backed execution.
