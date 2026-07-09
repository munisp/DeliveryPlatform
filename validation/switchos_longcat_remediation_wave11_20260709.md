# SwitchOS LongCat Remediation Wave 11 — Live PBX and Streaming Speech Hardening

**Author:** Manus AI  
**Date:** 2026-07-09

## Executive Summary

This remediation wave advanced LongCat from a provider-facing open-source voice surface toward a more realistic **self-hosted PBX and streaming-speech architecture**. The highest-value code gap that was still feasible inside the sandbox was the absence of a **protocol-native live ingress path** and the absence of **stream-shaped STT/TTS service contracts**. I addressed both.

In this wave, I extended the existing Go **voice gateway** from an HTTP-only forwarding service into an **AudioSocket-style TCP ingress surface** suitable for Asterisk-oriented deployments, and I extended the Python **speech runtime** with **streaming STT and TTS endpoints**, including WebSocket and chunk-oriented request paths. The Node production build continued to pass, the Go gateway built successfully, and the Python speech runtime compiled successfully.

The remaining blockers are no longer primarily code-shape blockers. They are now mostly **infrastructure and engine availability blockers**: a live PBX, installed streaming STT backends, installed streaming TTS models, and a persistent stage environment where APISIX, Redis, PostgreSQL, Kafka/Dapr/Fluvio, OpenSearch, Keycloak, Permify, and related services can be exercised end to end.

## What Was Implemented in This Wave

| Area | Change | Impact |
| --- | --- | --- |
| **Go voice gateway** | Added an **AudioSocket-style TCP listener** in `services/go/voice-gateway/main.go` that can accept framed PBX audio traffic, recognize UUID/DTMF/audio packet classes, bootstrap LongCat sessions, and forward audio chunks to the speech runtime. | Moves the gateway closer to a **real PBX ingress bridge** instead of only an HTTP metadata surface. |
| **Python speech runtime** | Extended `services/python/speech-runtime/main.py` with `/stt/stream-chunk`, `/ws/stt`, and `/ws/tts` in addition to the existing request-response endpoints. | Gives the LongCat stack a **real streaming contract surface** for future faster-whisper/Piper-style runtime installation. |
| **Validation** | Re-ran focused **Go**, **Python**, and **Node production build** validation after the new ingress and streaming paths were added. | Confirms the new code compiles and does not regress the production bundle path. |

## Honest Readiness Delta

| Component | Prior posture | Current posture | Readiness delta |
| --- | --- | --- | --- |
| **LongCat telephony ingress** | Provider-facing HTTP scaffolding only | Protocol-aware **AudioSocket-style TCP ingress surface** now exists in Go, but still lacks live PBX proof | **Improved materially** |
| **Streaming STT** | Non-streaming fallback request surface | Streaming endpoints now exist, but still rely on `transcript_hint` unless a real engine is installed | **Improved structurally** |
| **Streaming TTS** | Request-response only | Request-response plus **WebSocket TTS streaming contract**; still needs a live Piper or equivalent engine/model | **Improved structurally** |
| **Persistent middleware proof** | Not available in sandbox | Still blocked by environment, not by route design alone | **Unchanged blocker class** |

## Validation Evidence

The following focused validation was executed after the new ingress and streaming speech changes:

| Validation target | Result | Notes |
| --- | --- | --- |
| `services/go/voice-gateway` build | **Passed** | Confirms the new AudioSocket-style ingress logic compiles. |
| `services/python/speech-runtime/main.py` bytecode compile | **Passed** | Confirms the Python speech runtime remains syntactically valid after adding streaming endpoints. |
| `npm run build` | **Passed** | Confirms the production client/server bundle path remains healthy after the LongCat changes. |

## Remaining Blockers

### 1. Live PBX Infrastructure

The Go gateway now exposes a **protocol-native ingress surface**, but there is still no live PBX instance in this sandbox. That means the following items remain blocked by infrastructure rather than missing code shape:

| Remaining live-PBX blocker | Why it still blocks proof |
| --- | --- |
| **Asterisk or FreeSWITCH instance** | No running PBX is available here to originate or receive real call audio. |
| **Carrier/SIP trunk or internal extension fabric** | No reachable trunk, DID, or extension mesh exists in the sandbox. |
| **Persistent public or internal network path** | Real telephony ingress requires stable addressing and long-lived connectivity beyond the default sandbox lifecycle. |
| **PBX dialplan and gateway registration** | The new gateway is provider-facing, but not yet attached to a real dialplan or call-routing configuration. |

### 2. Streaming Speech Engines

The Python runtime now has the **right streaming interfaces**, but the actual engines are still not installed.

| Remaining speech blocker | Current behavior | Required next step |
| --- | --- | --- |
| **Streaming STT engine** | `/stt/stream-chunk` and `/ws/stt` accept chunks but degrade unless `transcript_hint` is supplied. | Install and wire a real engine such as a faster-whisper-compatible streaming worker. |
| **Streaming TTS engine and model** | `/tts/synthesize` and `/ws/tts` degrade unless Piper and a real model are installed. | Install `piper` plus production voice models and validate latency/quality. |
| **Audio framing normalization** | The gateway can forward raw framed audio, but real engine-specific resampling and chunk cadence are still environment-dependent. | Add production resampling and buffering policies after engine installation. |

### 3. Persistent Stage Middleware

The remaining end-to-end proof still needs a host that can sustain the broader middleware topology.

| Middleware blocker | Why sandbox is insufficient |
| --- | --- |
| **APISIX and OpenAppSec** | Need persistent gateway processes and realistic north-south traffic paths. |
| **Redis, PostgreSQL, Kafka/Dapr/Fluvio, OpenSearch** | Need long-lived infra and replayable event flow beyond ad hoc sandbox sessions. |
| **Keycloak and Permify** | Need reachable identity and policy services for end-to-end authz proof. |
| **Temporal and Mojaloop** | Need persistent orchestration and settlement-facing topology for full replay proof. |
| **TigerBeetle and lakehouse** | Need durable service availability to validate finance/event side effects across waves. |

## Detailed Plan for the Remaining Blockers

## Phase A — Live PBX Infrastructure

The next production-relevant PBX plan should be executed on a **persistent Docker-capable host** or an already provisioned stage environment.

| Step | Implementation detail | Preferred language/service |
| --- | --- | --- |
| **A1. Stand up PBX** | Bring up **Asterisk** with AudioSocket support or **FreeSWITCH** with a comparable media-bridge model. | Infrastructure + PBX config |
| **A2. Register LongCat gateway** | Point PBX call routing to the new Go **voice gateway** on `LONGCAT_AUDIOSOCKET_ADDR`. | **Go** gateway |
| **A3. Bind internal LongCat core** | Keep Node as the durable session, memory, and action orchestration layer. | **TypeScript** |
| **A4. Wire event sinks** | Persist ingress state into PostgreSQL and operational events into Redis/Dapr/OpenSearch as configured. | **TypeScript** + middleware |
| **A5. Validate real calls** | Place test calls, capture UUID/audio frames, transcript flow, voice turns, callback escalation, and memory updates. | End-to-end proof |

## Phase B — Streaming STT/TTS Engines

| Step | Implementation detail | Preferred language/service |
| --- | --- | --- |
| **B1. Install STT backend** | Add a self-hosted **faster-whisper-compatible streaming worker** to the Python speech runtime or as a sibling Python worker. | **Python** |
| **B2. Install TTS backend** | Install **Piper** with one or more production-grade voice models and latency-tested synthesis settings. | **Python** |
| **B3. Add buffering and resampling** | Normalize PBX PCM frames into the sample-rate and chunk cadence required by the chosen STT backend. | **Go** ingress + **Python** engine |
| **B4. Add streaming backpressure** | Introduce session-level buffering, timeouts, and degraded-mode signaling for dropped or slow speech inference. | **Go** + **Python** |
| **B5. Add transcript confidence and partials** | Extend transcript payloads with confidence, partial/final distinction, and engine metadata. | **Python** + **TypeScript** |

## Phase C — Persistent Stage Middleware Proof

| Step | Implementation detail | Middleware targets |
| --- | --- | --- |
| **C1. Persistent stage host** | Move the stack to a persistent VM or stage cluster with Docker/system services. | All |
| **C2. Gateway path** | Route ingress through **APISIX** and, where configured, **OpenAppSec**. | APISIX, OpenAppSec |
| **C3. Identity and policy** | Enforce internal/service access through **Keycloak** and **Permify**. | Keycloak, Permify |
| **C4. Event backbone** | Publish LongCat voice events into **Kafka**, **Dapr pub/sub**, or **Fluvio** according to the enabled stack. | Kafka, Dapr, Fluvio |
| **C5. Search and analytics** | Persist searchable operational artifacts into **OpenSearch** and analytics summaries into the **lakehouse**. | OpenSearch, lakehouse |
| **C6. Workflow and finance adjacency** | Replay voice-driven actions through **Temporal**, settlement-aware flows, and related financial sidecars where relevant. | Temporal, Mojaloop, TigerBeetle |

## Recommended Next Actions

The next highest-value action is now to move this work onto **persistent infrastructure** and complete the missing runtime installations instead of adding more sandbox-only scaffolding.

| Priority | Next action | Reason |
| --- | --- | --- |
| **1** | Provision a **persistent host** that can run PBX, Redis, PostgreSQL, gateway, speech runtime, and middleware services continuously. | This is the main blocker for honest live proof. |
| **2** | Install a **real streaming STT engine** and a **Piper voice model** into the Python speech runtime. | The new service interfaces are ready, but real speech remains engine-blocked. |
| **3** | Attach the Go **voice gateway** to a live **Asterisk/FreeSWITCH** dialplan. | This is required to prove true telephony ingress beyond local compilation. |
| **4** | Run an end-to-end replay through **APISIX**, **Keycloak**, **Permify**, **Redis**, **PostgreSQL**, **OpenSearch**, and an enabled event bus. | This closes the persistent stage middleware proof gap. |
| **5** | Expand automated coverage to include the new **voice gateway** and **speech runtime** contracts. | Current validation is strong on build health, but runtime path coverage should deepen. |

## Bottom Line

This wave closed the most important remaining **code-architecture gap** that was still feasible in the sandbox: LongCat now has a **protocol-aware open-source PBX ingress surface** and **stream-shaped STT/TTS service contracts**. The dominant remaining blockers are now **environmental and engine-availability blockers**, not the absence of reasonable service boundaries.

That is a meaningful readiness improvement, but it is not yet full production proof. Real PBX infrastructure, installed streaming engines, and persistent stage middleware remain the next required execution frontier.
