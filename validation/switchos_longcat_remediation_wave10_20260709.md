# SwitchOS LongCat Remediation Wave 10 — Open-Source Telephony Ingress and Streaming Speech Plan

**Date:** 2026-07-09  
**Author:** Manus AI

## Executive Summary

This wave moved the LongCat roadmap beyond workspace-only voice assistance and into a **provider-facing open-source telephony ingress posture**. I replaced the previously explored Twilio-oriented direction with an **open-source-first design** centered on **Asterisk-style audio ingress**, a new **Go voice gateway**, a **Python speech runtime**, and the existing **TypeScript LongCat orchestration** plus **Rust voice-priority scoring**. The practical result is that the platform now has a real, self-hostable control-plane path for call-session bootstrap, transcript ingestion, speech playback planning, and durable session persistence, even though true live PSTN ingress and streaming audio decoding still require persistent infrastructure and deployed speech binaries before they can be claimed as production-ready [1] [2] [3].

In this wave, the highest-value feasible implementation slice was completed honestly. The TypeScript backend now persists **telephony ingress sessions** and **speech events** in PostgreSQL, exposes internal authenticated routes for session bootstrap and transcript streaming, and can request synthesized playback through a dedicated speech-runtime interface. A new **Go `voice-gateway` service** now provides provider-facing ingress endpoints for session bootstrap and transcript forwarding. A new **Python `speech-runtime` service** now provides self-hosted STT and TTS endpoint shapes, with honest fallback behavior when a local streaming STT engine or a Piper model is not yet installed. The existing **Rust dispatch optimizer** remains in the execution loop through LongCat voice-priority scoring.

## What Was Implemented in This Wave

| Area | Implementation | Runtime role | Status |
| --- | --- | --- | --- |
| Durable telephony persistence | Added `longcat_voice_ingress_sessions` and `longcat_voice_speech_events` tables in `server/_core/longcatVoice.ts` | Stores external call IDs, transport metadata, speech event direction, engine, and degraded-mode history | Implemented |
| TypeScript voice orchestration | Added `startLongCatTelephonyIngressSession`, `appendLongCatTelephonyTranscript`, and `synthesizeLongCatSpeech` | Bridges telephony ingress into LongCat memory, turn handling, callback logic, lakehouse ingestion, and operational events | Implemented |
| Internal API surface | Added `/api/internal/longcat/voice/bootstrap` and `/api/internal/longcat/voice/transcript` in `server/_core/index.ts` | Gives internal services a clean authenticated interface for session startup and transcript turns | Implemented |
| Go ingress gateway | Added `services/go/voice-gateway/main.go` and module manifest | Provides provider-facing HTTP ingress for open-source PBX adapters and forwards events into the TypeScript LongCat core | Implemented |
| Python speech runtime | Added `services/python/speech-runtime/main.py` | Provides self-hosted `/stt/transcribe` and `/tts/synthesize` endpoints with Piper-aware and transcript-hint-aware behavior | Implemented |
| Open-source design baseline | Shifted the telephony plan to Asterisk-compatible ingress and self-hosted speech engines | Keeps the LongCat roadmap aligned with non-proprietary infrastructure | Implemented |

## Detailed Remaining-Blocker Plan

The remaining LongCat blockers are now clear enough to sequence as a concrete execution program instead of a loose wish list. The next work should proceed in five tracks that build on the code added in this wave.

| Track | Objective | Primary languages | Middleware and runtime touchpoints | Honest blocker |
| --- | --- | --- | --- | --- |
| 1. Real PBX ingress | Accept live call media from Asterisk or FreeSWITCH into the Go gateway | Go, TypeScript | APISIX, OpenAppSec, Redis, PostgreSQL | Requires a persistent host and a real PBX or SIP environment |
| 2. Streaming STT | Turn live PCM or framed audio into partial and final transcripts | Python, Go | Redis, Kafka or Fluvio, PostgreSQL | Requires a deployed streaming STT engine such as faster-whisper or WhisperLive |
| 3. Streaming TTS | Generate low-latency playback audio for assistant prompts | Python, Go | Redis, PostgreSQL, optional lakehouse analytics | Requires Piper binaries plus installed voices or another self-hosted TTS engine |
| 4. Real-time session control | Support barge-in, DTMF, call-transfer state, and handoff policies | TypeScript, Go, Rust | Redis, Temporal, Permify, Keycloak | Requires live telephony transport and more explicit action-safety policies |
| 5. Full middleware proof | Prove event replay, analytics ingestion, and security routing in stage | Go, Python, TypeScript, Rust | Kafka, Dapr, Fluvio, OpenSearch, APISIX, OpenAppSec, lakehouse | Requires stage infrastructure or a Docker-capable persistent host |

### Track 1: Real PBX ingress

The open-source telephony design should now anchor on the **Asterisk AudioSocket model**, which is a TCP-based real-time audio transport carrying PCM payloads, DTMF, and stream association data such as UUIDs [1]. The new Go gateway should be extended from its current HTTP ingress surface into an **AudioSocket or equivalent PBX bridge** that maps each external call UUID to a LongCat session. The gateway should then normalize audio frames, enforce internal authentication, and forward transcript or stream-state events to the TypeScript core. This is the correct place to terminate PBX-specific protocol logic because it keeps the Node application focused on business orchestration instead of low-level media framing.

### Track 2: Streaming STT

The Python speech runtime now has the correct service shape but still degrades honestly when no true STT backend is present. The next step is to install and wire a real streaming engine. The strongest open-source path is to place **faster-whisper** or a near-live wrapper such as **WhisperLive** behind the Python runtime so partial and final transcript segments can be emitted incrementally [2] [3]. The Go gateway should buffer framed audio into segment windows, while Redis should hold short-lived partial transcript state and PostgreSQL should retain final speech events only.

### Track 3: Streaming TTS

The Python runtime is already **Piper-aware** and can synthesize real WAV audio if the Piper binary and model are installed. That means the code path is ready, but the runtime is not yet fully live in this sandbox. Piper remains the right self-hosted TTS target because it is fast, local, and designed as an offline neural speech system [4]. The next stage is to install real voices, decide on a voice-selection policy, and optionally cache repeated assistant phrases in Redis to reduce latency.

### Track 4: Real-time session control and safety

Once live ingress and streaming speech are active, the TypeScript orchestration layer should be extended with explicit **turn-state transitions**, **agent override rules**, **merchant-confirmation gates**, and **policy checks**. Keycloak should continue to protect operator surfaces, Permify should gate privileged call actions, Redis should carry ephemeral live session state, and Temporal should own any longer-running callback or merchant confirmation workflow. The Rust layer should remain responsible for latency-sensitive priority scoring and can later add a session-complexity or queue-pressure score if needed.

### Track 5: Full middleware-backed proof

The final blocker remains the same class of blocker identified in earlier waves: end-to-end proof. The platform needs a real environment where APISIX, OpenAppSec, Redis, PostgreSQL, Kafka or Fluvio, lakehouse services, and the new Go and Python services can be deployed together so ingress, event replay, analytics, and operational evidence can be captured honestly. This wave did not overclaim that stage, because the current sandbox still lacks the persistent PBX and always-on speech infrastructure required for that proof.

## Middleware Coverage in This Wave

| Middleware / service | Role in LongCat voice path after this wave | Evidence |
| --- | --- | --- |
| PostgreSQL | Durable storage for customer memory, voice sessions, telephony ingress sessions, and speech events | New tables and session persistence implemented |
| Redis | Still used for short-lived memory caching in the existing LongCat path | Existing cache path preserved |
| Rust dispatch optimizer | Continues to provide LongCat voice-priority scoring | Existing integration retained |
| Lakehouse | Still receives LongCat memory and voice-session event ingestion from TypeScript | Existing ingestion path preserved |
| Operational event bus | Receives LongCat session and turn events | Existing event recording preserved |
| APISIX / OpenAppSec | Not yet exercised for the new voice gateway | Remains a stage proof blocker |
| Kafka / Fluvio / Dapr | Not yet wired for voice transcript fan-out or replay in this wave | Remains a next-step integration blocker |
| Temporal | Not yet assigned to long-lived voice callback workflows in this slice | Remains a next-step orchestration blocker |
| Keycloak / Permify | Existing platform auth and policy layers remain available, but live voice-action policy depth is still incomplete | Partial |
| Mojaloop / TigerBeetle | No new direct LongCat dependency in this wave | Unchanged |

## Validation Evidence

The validation results for this wave are strong for the code that was actually changed, and they remain honest about unrelated global TypeScript issues.

| Validation step | Result | Notes |
| --- | --- | --- |
| `npx vitest run tests/longcat.integration.test.ts --reporter=basic` | Passed | Existing LongCat integration tests still pass after the new ingress and speech changes |
| `npm run build` | Passed | Production client and server bundle still build successfully |
| `go build ./...` in `services/go/voice-gateway` | Passed | New Go voice-gateway service compiles |
| `go build ./...` in `services/go/notification-dispatcher` | Passed | Existing Go voice callback path still compiles |
| `python3 -m py_compile services/python/speech-runtime/main.py` | Passed | New Python speech-runtime entrypoint is syntactically valid |
| `npm run check` | Still blocked globally | The repository still has unrelated pre-existing TypeScript type issues outside this wave |

## Updated Readiness Impact

This wave improved the LongCat voice stack materially because it introduced a real **polyglot service boundary** for telephony ingress and speech. However, the platform is still not entitled to claim full production readiness for live telephony AI because live PBX traffic, installed speech engines, and stage middleware proof are not yet present.

| Component | Prior posture | New posture after this wave | Updated readiness score |
| --- | --- | --- | --- |
| LongCat consumer voice assistant | Persisted voice-session orchestration and callback flow, but no provider-facing ingress | Now has provider-facing Go ingress, internal bootstrap and transcript APIs, and speech-runtime integration points | 7.8 / 10 |
| Open-source telephony ingress | Design only | Implemented as a real service surface, but not yet connected to a live PBX | 6.2 / 10 |
| Streaming STT | Not present | Service surface implemented, but still fallback-only without installed backend | 4.9 / 10 |
| Streaming TTS | Not present | Piper-aware synthesis surface implemented, but still fallback-only without installed model | 5.3 / 10 |
| Historical personalization memory | Already durable and lakehouse-aware | Preserved and now connected to telephony ingress sessions | 8.4 / 10 |
| Polyglot middleware integration for voice | Partial | Stronger because TypeScript, Go, Python, Rust, PostgreSQL, Redis, and lakehouse are now connected conceptually and in code | 7.1 / 10 |

## Honest Residual Blockers

The remaining blockers are infrastructure-backed, not merely code-backed. The platform still needs a real PBX environment, always-on speech binaries, and stage middleware proof before it can claim true production readiness for LongCat voice. In particular, the Go gateway is **provider-facing but not yet protocol-native**, because the raw Asterisk AudioSocket or equivalent transport has not yet been implemented. The Python service is **engine-ready but not engine-live**, because there is no installed faster-whisper-compatible streaming runtime or Piper model in this sandbox. The TypeScript layer is **session-ready but not yet stage-proven**, because APISIX, OpenAppSec, Kafka, Fluvio, Dapr, and Temporal have not yet been exercised with the new voice path in a persistent deployment.

## Recommended Next Actions

The next highest-value action is to extend the new **Go voice gateway** into a real **Asterisk AudioSocket or FreeSWITCH-compatible media bridge** and then deploy it on persistent infrastructure. In parallel, the **Python speech runtime** should be upgraded from honest fallback mode into a real streaming STT/TTS runtime by installing faster-whisper or WhisperLive plus Piper voices. After that, the TypeScript layer should add **live turn-state control**, **agent override rules**, **merchant confirmation gates**, and **Temporal-backed callback workflows** so the voice path gains execution safety equal to its new ingress depth.

## References

[1]: https://docs.asterisk.org/Configuration/Channel-Drivers/AudioSocket/ "Asterisk Documentation — AudioSocket"
[2]: https://github.com/SYSTRAN/faster-whisper "SYSTRAN/faster-whisper"
[3]: https://github.com/collabora/WhisperLive "collabora/WhisperLive"
[4]: https://github.com/rhasspy/piper "rhasspy/piper"
