# SwitchOS LongCat Remediation Wave 13 — Terminal Session Gating and Remaining Action Plan

**Author:** Manus AI  
**Date:** 2026-07-09

## Executive Summary

This remediation wave focused on the **highest-value remaining LongCat gap that was still feasible to close locally after waves 10 through 12**: once PBX-style ingress sessions were explicitly closable, the platform still needed to ensure that **late, duplicated, or replayed transcript traffic could not continue mutating a session after closure**. That gap is now closed.

In this wave, I hardened the TypeScript LongCat voice core so **terminal voice-session states are now enforced as write barriers**. A session that is already `completed`, `failed`, `abandoned`, or `closed` can no longer accept additional telephony transcript turns. I also updated the internal Node transcript route so this condition returns an honest **HTTP 409 conflict** instead of a misleading generic 500, and I extended the focused LongCat test suite to validate the terminal-state contract explicitly.

This is a meaningful production-hardening improvement because it closes a common edge case in PBX and streaming environments: **late-arriving packets, duplicate provider retries, or delayed transcript submission after a disconnect**. The system now treats those as a conflict against finalized state rather than silently extending or corrupting the call record.

## What Was Implemented

| Area | Change | Why it matters |
| --- | --- | --- |
| **TypeScript LongCat core** | Added `isLongCatVoiceSessionTerminal()` and enforced terminal-state gating inside `appendLongCatVoiceTurn()` in `server/_core/longcatVoice.ts`. | Transcript replay can no longer mutate a call after session closure or failure. |
| **Node internal ingress route** | Updated `/api/internal/longcat/voice/transcript` in `server/_core/index.ts` to map post-close transcript writes to **409 Conflict**. | PBX and speech-runtime callers now receive an honest lifecycle response instead of a generic server error. |
| **Automated validation** | Extended `tests/longcat.integration.test.ts` with explicit coverage for terminal LongCat session states. | The new lifecycle barrier is backed by executable validation rather than only a design claim. |

## Detailed Implementation Notes

### 1. Terminal Session State Enforcement

The most important code-level change in this wave is that the LongCat voice core now treats the following states as **terminal**:

| Terminal state | Meaning |
| --- | --- |
| `completed` | The voice workflow finished normally and should not accept more turns. |
| `failed` | The voice workflow ended in an error state and should not continue. |
| `abandoned` | The caller or upstream transport dropped out before successful completion. |
| `closed` | The session has already been finalized administratively or through lifecycle controls. |

Before this change, the platform had already gained explicit PBX-style close handling, but there was still a risk that **delayed transcript delivery** could continue to append turns after the call had been finalized. That is now rejected centrally in the TypeScript voice core before new assistant work, memory mutation, or callback action handling can occur.

### 2. Honest Conflict Behavior for Ingress Clients

The internal Node ingress route now distinguishes between a genuine server failure and a **post-close lifecycle conflict**.

| Condition | New route behavior |
| --- | --- |
| Transcript received for an active session | Normal processing continues. |
| Transcript received for a terminal session | Returns **409 Conflict** with the closure message. |
| Unexpected internal failure | Returns **500** as before. |

This matters operationally because PBX bridges, speech runtimes, and middleware callers can now **differentiate a race-condition replay from an application fault**. That distinction is important for future retry behavior, alerting quality, and middleware orchestration safety.

### 3. Why This Was the Highest-Value Local Gap

At this stage of the remediation program, the largest remaining blockers are increasingly infrastructure-bound. Within the sandbox, the most important remaining local work is to close **state-integrity gaps** around voice lifecycle, replay behavior, and safe action boundaries.

This wave was therefore prioritized because it directly protects against:

| Failure mode | Effect without this wave | Effect after this wave |
| --- | --- | --- |
| Late PBX transcript after disconnect | Session could continue mutating after closure | Rejected as a terminal-state conflict |
| Duplicate provider or middleware retry | Duplicate transcript could reopen workflow behavior implicitly | Rejected without mutating state |
| Delayed STT final segment after call finalization | Could produce extra assistant response or downstream action | Blocked centrally before execution |

## Validation Evidence

The following targeted validation was executed after the changes:

| Validation target | Result | Evidence |
| --- | --- | --- |
| `npx vitest run tests/longcat.integration.test.ts` | **Passed** | 5 tests passed, including the new terminal-session gating case. |
| `npm run build` | **Passed** | Production Vite + server bundle build completed successfully. |
| `go build ./...` in `services/go/voice-gateway` | **Passed** | Confirms the Go PBX-facing gateway still compiles after the new lifecycle barrier integration. |
| `python3 -m py_compile services/python/speech-runtime/main.py` | **Passed** | Confirms the Python speech runtime remains syntactically valid after the broader voice-stack hardening. |

## Readiness Impact

| Component | Previous posture | Current posture | Readiness impact |
| --- | --- | --- | --- |
| **LongCat telephony session integrity** | Session closure existed, but late transcript replay could still mutate closed sessions | Terminal session states now block new turns centrally | **Improved materially** |
| **Ingress error semantics** | Post-close transcript writes would surface as generic failures | Post-close transcript writes now return honest conflict semantics | **Improved materially** |
| **Voice lifecycle safety** | Closure, callback gating, and replay handling were not yet all aligned | Session close, callback confirmation, and replay rejection now form a more coherent lifecycle contract | **Improved materially** |
| **PBX live proof** | Still infrastructure-blocked | Still infrastructure-blocked | **No direct delta** |
| **Streaming speech engine proof** | Still engine-blocked | Still engine-blocked | **No direct delta** |
| **Persistent middleware proof** | Still stage-blocked | Still stage-blocked | **No direct delta** |

## Remaining Gaps and Honest Blockers

The dominant remaining gaps are now mostly **outside the local code-only repair frontier**.

### A. Live PBX Infrastructure

| Remaining blocker | Why it still matters |
| --- | --- |
| **Persistent Asterisk or FreeSWITCH deployment** | The Go gateway now has provider-facing and protocol-native surfaces, but there is still no always-on PBX here to prove live call ingress. |
| **Real dialplan / media bridge configuration** | No live extension routing, DTMF confirmation path, or caller-network ingress is connected to the gateway. |
| **Stable network path and service uptime** | Real voice ingress requires persistent addressing and uptime beyond the sandbox lifecycle. |

### B. Real Streaming STT and TTS Engines

| Remaining blocker | Why it still matters |
| --- | --- |
| **Installed streaming STT backend** | The Python speech runtime exposes streaming contracts, but a real continuously running engine is still required for live audio proof. |
| **Installed Piper or equivalent production TTS assets** | TTS remains contract-ready but engine-bound until the runtime has actual self-hosted voice binaries and models. |
| **Latency, buffering, and resampling proof under load** | This requires real cadence from a live PBX audio source and sustained speech-engine execution. |

### C. Persistent Stage Middleware Proof

| Remaining blocker | Why it still matters |
| --- | --- |
| **APISIX and OpenAppSec live ingress path** | The voice flow is not yet proven through the real stage gateway and security layer. |
| **Redis, PostgreSQL, Kafka, Dapr, Fluvio, and OpenSearch replay proof** | The event and persistence hooks exist, but integrated end-to-end replay on persistent infrastructure is still missing. |
| **Keycloak, Permify, Temporal, Mojaloop, TigerBeetle, and lakehouse stage topology** | Broader platform proof requires a durable multi-service stage, not additional sandbox-only scaffolding. |

## Detailed Plan for the Remaining Recommended Next Actions

The most honest next plan is now to shift from local integrity fixes into **persistent infrastructure execution** while still deepening runtime contract coverage where possible.

### Phase 1 — Live PBX Infrastructure Bring-Up

| Step | Action | Primary stack |
| --- | --- | --- |
| **1.1** | Provision a persistent VM or Docker-capable host for PBX, Node core, Go gateway, Python speech runtime, Redis, and PostgreSQL. | Infrastructure |
| **1.2** | Deploy **Asterisk** with AudioSocket-enabled dialplan or **FreeSWITCH** with an equivalent media bridge. | PBX |
| **1.3** | Wire the PBX media path to `services/go/voice-gateway` and verify session bootstrap, disconnect closure, and late-packet rejection behavior. | **Go** + **TypeScript** |
| **1.4** | Validate DTMF capture, caller metadata forwarding, and post-close replay rejection through the internal LongCat routes. | **Go** + **TypeScript** |
| **1.5** | Capture lifecycle evidence into PostgreSQL, lakehouse, and operational events for each call path. | **TypeScript** + **Python** |

### Phase 2 — Real Streaming STT and TTS Engine Activation

| Step | Action | Primary stack |
| --- | --- | --- |
| **2.1** | Install a self-hosted streaming STT backend suitable for continuous telephony audio. | **Python** |
| **2.2** | Install **Piper** or an equivalent self-hosted TTS runtime with validated production voice assets. | **Python** |
| **2.3** | Add partial versus final transcript confidence semantics and real buffering or resampling behavior under live stream cadence. | **Go** + **Python** + **TypeScript** |
| **2.4** | Propagate engine-readiness and degraded-mode metadata all the way through LongCat session events and operator surfaces. | **Python** + **TypeScript** |
| **2.5** | Measure end-to-end latency and tune speech timeouts, batching, and failure fallback thresholds. | **Go** + **Python** |

### Phase 3 — Persistent Stage Middleware Proof

| Step | Action | Middleware / services |
| --- | --- | --- |
| **3.1** | Route LongCat ingress through **APISIX** and, where enabled, **OpenAppSec**. | APISIX, OpenAppSec |
| **3.2** | Enforce service identity and operator access via **Keycloak** and **Permify**. | Keycloak, Permify |
| **3.3** | Publish voice lifecycle and safety events through the enabled event bus (**Kafka**, **Dapr**, or **Fluvio**). | Kafka, Dapr, Fluvio |
| **3.4** | Persist searchable operations artifacts into **OpenSearch** and analytics into the **lakehouse**. | OpenSearch, lakehouse |
| **3.5** | Exercise Temporal- and finance-adjacent action flows where LongCat escalates into downstream workflows safely. | Temporal, Mojaloop, TigerBeetle |

### Phase 4 — Remaining Local Contract Hardening

| Step | Action | Why it still matters locally |
| --- | --- | --- |
| **4.1** | Add focused automated coverage for telephony close-route semantics and replay rejection at the HTTP route layer. | This would deepen validation beyond pure helper behavior. |
| **4.2** | Add explicit speech-engine readiness surfacing and degraded-mode contract tests. | This is the next best local safety signal while engines remain absent. |
| **4.3** | Extend operator workspace views with session terminal-state and degraded-engine diagnostics. | This improves operational visibility before live stage proof exists. |

## Recommended Next Actions

| Priority | Next action | Reason |
| --- | --- | --- |
| **1** | Move the PBX, Go gateway, Python speech runtime, and LongCat core to a **persistent host**. | Persistent infrastructure is now the main blocker class. |
| **2** | Install a real **streaming STT backend** and **Piper or equivalent TTS assets**. | The speech contracts exist, but the real engines do not. |
| **3** | Connect the Go voice gateway to a live **Asterisk or FreeSWITCH** dialplan and verify post-close replay rejection on real traffic. | This closes the live telephony ingress proof gap. |
| **4** | Run an end-to-end middleware-backed replay through **APISIX**, **Redis**, **PostgreSQL**, **OpenSearch**, and one enabled event bus. | This closes the persistent stage proof gap. |
| **5** | Add route-level replay rejection tests and speech-engine degraded-mode contract coverage. | This is the highest-value remaining local validation work. |

## Bottom Line

This wave closed an important **remaining local integrity gap** in the LongCat voice stack. The platform now rejects transcript replay into sessions that are already terminal, and it reports that state honestly to ingress callers through a conflict response instead of a generic failure.

The remaining work is now predominantly about **persistent infrastructure and real engine execution**: live PBX deployment, installed streaming STT/TTS runtimes, and a durable stage environment where the broader middleware topology can be proven end to end. Within the sandbox, the best remaining work has shifted further from structural voice logic into **runtime-contract depth and infrastructure-backed proof**.
